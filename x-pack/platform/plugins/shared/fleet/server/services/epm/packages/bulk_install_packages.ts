/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, SavedObjectsClientContract } from '@kbn/core/server';

import pLimit from 'p-limit';
import { uniqBy } from 'lodash';

import type { HTTPAuthorizationHeader } from '../../../../common/http_authorization_header';

import { appContextService } from '../../app_context';
import * as Registry from '../registry';

import type { InstallResult } from '../../../types';

import { installPackage, isPackageVersionOrLaterInstalled } from './install';
import type { BulkInstallResponse, IBulkInstallPackageError } from './install';
import {
  resolveDependencies,
  throwOnResolutionFailure,
  packageInfoToPackageWithDependencies,
  type PackageWithDependencies,
} from './resolve_dependencies';
import { getInstallationsByName } from './get';

interface BulkInstallPackagesParams {
  savedObjectsClient: SavedObjectsClientContract;
  packagesToInstall: Array<
    | string
    | { name: string; version?: string; prerelease?: boolean; skipDataStreamRollover?: boolean }
  >;
  esClient: ElasticsearchClient;
  force?: boolean;
  spaceId: string;
  preferredSource?: 'registry' | 'bundled';
  prerelease?: boolean;
  authorizationHeader?: HTTPAuthorizationHeader | null;
  skipIfInstalled?: boolean;
}

export async function bulkInstallPackages({
  savedObjectsClient,
  packagesToInstall,
  esClient,
  spaceId,
  force,
  prerelease,
  authorizationHeader,
  skipIfInstalled,
}: BulkInstallPackagesParams): Promise<BulkInstallResponse[]> {
  const logger = appContextService.getLogger();

  const uniquePackages = uniqBy(packagesToInstall, (pkg) => {
    if (typeof pkg === 'string') {
      return pkg;
    }

    return pkg.name;
  });

  const limiter = pLimit(10);

  const packagesResults = await Promise.allSettled(
    uniquePackages.map(async (pkg) => {
      return limiter(async () => {
        if (typeof pkg === 'string') {
          return Registry.fetchFindLatestPackageOrThrow(pkg, {
            prerelease,
          }).then((pkgRes) => ({
            name: pkgRes.name,
            version: pkgRes.version,
            prerelease: undefined,
            skipDataStreamRollover: undefined,
          }));
        }
        if (pkg.version !== undefined) {
          return Promise.resolve(
            pkg as {
              name: string;
              version: string;
              prerelease?: boolean;
              skipDataStreamRollover?: boolean;
            }
          );
        }

        return Registry.fetchFindLatestPackageOrThrow(pkg.name, {
          prerelease: prerelease || pkg.prerelease,
        }).then((pkgRes) => ({
          name: pkgRes.name,
          version: pkgRes.version,
          prerelease: pkg.prerelease,
          skipDataStreamRollover: pkg.skipDataStreamRollover,
        }));
      });
    })
  );

  logger.debug(
    `kicking off bulk install of ${packagesToInstall
      .map((pkg) => (typeof pkg === 'string' ? pkg : pkg.name))
      .join(', ')}`
  );

  // Pre-validate dependencies across all packages before starting any installation
  // This ensures we catch conflicts early (e.g., package A requires dep@1.x, package B requires dep@2.x)
  const resolvedPackages = packagesResults
      .filter((r): r is PromiseFulfilledResult<{ name: string; version: string }> =>
        r.status === 'fulfilled'
      )
      .map((r) => r.value);

  if (resolvedPackages.length > 0) {
    // Fetch package info with dependencies for all packages
    const packagesWithDeps: PackageWithDependencies[] = await Promise.all(
      resolvedPackages.map(async (pkg) => {
        try {
          const { packageInfo } = await Registry.getPackage(pkg.name, pkg.version, {
            useStreaming: true,
          });
          return packageInfoToPackageWithDependencies(packageInfo);
        } catch {
          // If we can't fetch package info, return without dependencies
          return { name: pkg.name, version: pkg.version };
        }
      })
    );

    // Only run dependency resolution if any package has dependencies
    const hasAnyDependencies = packagesWithDeps.some(
      (p) => p.dependencies && p.dependencies.length > 0
    );

    if (hasAnyDependencies) {
      // Get all installed packages
      const allPackageNames = new Set<string>();
      for (const pkg of packagesWithDeps) {
        allPackageNames.add(pkg.name);
        if (pkg.dependencies) {
          for (const dep of pkg.dependencies) {
            allPackageNames.add(dep.name);
          }
        }
      }

      const installedPackages = await getInstallationsByName({
        savedObjectsClient,
        pkgNames: Array.from(allPackageNames),
      });

      const resolution = resolveDependencies(installedPackages, packagesWithDeps);

      // This will throw if there are conflicts or cycles
      throwOnResolutionFailure(resolution);

      logger.debug(
        `Dependency resolution successful for bulk install. Install order: ${resolution.installOrder
          ?.map((p) => `${p.name}@${p.version}`)
          .join(' -> ')}`
      );
    }
  }

  const bulkInstallResults = await Promise.allSettled(
    packagesResults.map(async (result, index) => {
      const packageName = getNameFromPackagesToInstall(packagesToInstall, index);

      if (result.status === 'rejected') {
        return { name: packageName, error: result.reason };
      }

      const pkgKeyProps = result.value;
      if (!force || skipIfInstalled) {
        const installedPackageResult = await isPackageVersionOrLaterInstalled({
          savedObjectsClient,
          pkgName: pkgKeyProps.name,
          pkgVersion: pkgKeyProps.version,
        });

        if (installedPackageResult) {
          const {
            name,
            version,
            installed_es: installedEs,
            installed_kibana: installedKibana,
          } = installedPackageResult.package;
          return {
            name,
            version,
            result: {
              assets: [...installedEs, ...installedKibana],
              status: 'already_installed',
              installType: 'unknown',
            } as InstallResult,
          };
        }
      }

      const pkgkey = Registry.pkgToPkgKey(pkgKeyProps);

      const installResult = await installPackage({
        savedObjectsClient,
        esClient,
        pkgkey,
        installSource: 'registry',
        spaceId,
        force,
        prerelease: prerelease || ('prerelease' in pkgKeyProps && pkgKeyProps.prerelease),
        authorizationHeader,
        skipDataStreamRollover: pkgKeyProps.skipDataStreamRollover,
      });

      if (installResult.error) {
        return {
          name: packageName,
          error: installResult.error,
          installType: installResult.installType,
        };
      }

      const { pkgName, ...restOfInstallResult } = installResult;

      return {
        name: packageName,
        version: pkgKeyProps.version,
        result: restOfInstallResult,
      };
    })
  );

  return bulkInstallResults.map((result, index) => {
    const packageName = getNameFromPackagesToInstall(packagesToInstall, index);
    if (result.status === 'fulfilled') {
      if (result.value && result.value.error) {
        return {
          name: packageName,
          error: result.value.error,
          installType: result.value.installType,
        };
      } else {
        return result.value;
      }
    } else {
      return { name: packageName, error: result.reason };
    }
  });
}

export function isBulkInstallError(
  installResponse: any
): installResponse is IBulkInstallPackageError {
  return 'error' in installResponse && installResponse.error instanceof Error;
}

function getNameFromPackagesToInstall(
  packagesToInstall: BulkInstallPackagesParams['packagesToInstall'],
  index: number
) {
  const entry = packagesToInstall[index];
  if (typeof entry === 'string') return entry;
  return entry.name;
}
