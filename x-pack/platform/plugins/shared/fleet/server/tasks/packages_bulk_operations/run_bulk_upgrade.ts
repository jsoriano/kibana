/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { DEFAULT_SPACE_ID } from '@kbn/spaces-plugin/common';
import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';
import type { ElasticsearchClient, Logger, SavedObjectsClientContract } from '@kbn/core/server';

import { HTTPAuthorizationHeader } from '../../../common/http_authorization_header';
import { installPackage } from '../../services/epm/packages';
import { appContextService, packagePolicyService } from '../../services';
import { PACKAGE_POLICY_SAVED_OBJECT_TYPE, SO_SEARCH_LIMIT } from '../../constants';
import * as Registry from '../../services/epm/registry';
import { getInstallationsByName } from '../../services/epm/packages/get';
import {
  resolveDependencies,
  throwOnResolutionFailure,
  packageInfoToPackageWithDependencies,
  type PackageWithDependencies,
} from '../../services/epm/packages/resolve_dependencies';

import { scheduleBulkOperationTask, formatError } from './utils';

export interface BulkUpgradeTaskParams {
  type: 'bulk_upgrade';
  packages: Array<{ name: string; version?: string }>;
  spaceId?: string;
  authorizationHeader: HTTPAuthorizationHeader | null;
  force?: boolean;
  prerelease?: boolean;
  upgradePackagePolicies?: boolean;
}

interface BulkUpgradeTaskState {
  isDone?: boolean;
  error?: { message: string };
  results?: Array<
    | {
        success: true;
        name: string;
      }
    | { success: false; name: string; error: { message: string } }
  >;
  [k: string]: unknown;
}

export async function _runBulkUpgradeTask({
  abortController,
  taskParams,
  logger,
}: {
  taskParams: BulkUpgradeTaskParams;
  abortController: AbortController;
  logger: Logger;
}) {
  const {
    packages,
    spaceId = DEFAULT_SPACE_ID,
    authorizationHeader,
    force,
    prerelease,
    upgradePackagePolicies,
  } = taskParams;
  const esClient = appContextService.getInternalUserESClient();
  const savedObjectsClient = appContextService.getInternalUserSOClientForSpaceId(spaceId);

  const results: BulkUpgradeTaskState['results'] = [];

  // Pre-validate dependencies across all packages before starting any installation.
  // This allows upgrading multiple packages atomically even if they have co-dependent
  // version requirements (e.g., A@2.0.0 and B@2.0.0 both require C@^2.0.0, while the
  // currently installed A@1.0.0 and B@1.0.0 require C@^1.0.0).
  const resolvedPackages = await Promise.all(
    packages.map(async (pkg) => {
      if (pkg.version) {
        return { name: pkg.name, version: pkg.version };
      }
      const latestPkg = await Registry.fetchFindLatestPackageOrThrow(pkg.name, { prerelease });
      return { name: latestPkg.name, version: latestPkg.version };
    })
  );

  // Fetch package info with dependencies for all packages
  const packagesWithDeps: PackageWithDependencies[] = await Promise.all(
    resolvedPackages.map(async (pkg) => {
      try {
        const { packageInfo } = await Registry.getPackage(pkg.name, pkg.version, {
          useStreaming: true,
        });
        return packageInfoToPackageWithDependencies(packageInfo);
      } catch {
        return { name: pkg.name, version: pkg.version };
      }
    })
  );

  // Only run dependency resolution if any package has dependencies
  const hasAnyDependencies = packagesWithDeps.some(
    (p) => p.dependencies && p.dependencies.length > 0
  );

  if (hasAnyDependencies) {
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
    throwOnResolutionFailure(resolution);

    logger.debug(
      `Dependency resolution successful for bulk upgrade. Install order: ${resolution.installOrder
        ?.map((p) => `${p.name}@${p.version}`)
        .join(' -> ')}`
    );
  }

  for (const pkg of packages) {
    // Throw between package install if task is aborted
    if (abortController.signal.aborted) {
      throw new Error('Task was aborted');
    }
    try {
      const installResult = await installPackage({
        spaceId,
        authorizationHeader: authorizationHeader
          ? new HTTPAuthorizationHeader(
              authorizationHeader.scheme,
              authorizationHeader.credentials,
              authorizationHeader.username
            )
          : undefined,
        installSource: 'registry', // Upgrade can only happens from the registry,
        esClient,
        savedObjectsClient,
        pkgkey: pkg?.version ? `${pkg.name}-${pkg.version}` : pkg.name,
        force,
        prerelease,
      });

      if (installResult.error) {
        throw installResult.error;
      }

      if (upgradePackagePolicies) {
        await bulkUpgradePackagePolicies({
          savedObjectsClient,
          esClient,
          pkgName: pkg.name,
        });
      }

      results.push({
        name: pkg.name,
        success: true,
      });
    } catch (error) {
      logger.error(`Upgrade of package: ${pkg.name} failed`, { error });
      results.push({
        name: pkg.name,
        success: false,
        error: formatError(error),
      });
    }
  }
  return results;
}

async function bulkUpgradePackagePolicies({
  savedObjectsClient,
  esClient,
  pkgName,
}: {
  savedObjectsClient: SavedObjectsClientContract;
  esClient: ElasticsearchClient;
  pkgName: string;
}) {
  const policyIdsToUpgrade = await packagePolicyService.listIds(savedObjectsClient, {
    page: 1,
    perPage: SO_SEARCH_LIMIT,
    kuery: `${PACKAGE_POLICY_SAVED_OBJECT_TYPE}.package.name:${pkgName}`,
  });

  if (policyIdsToUpgrade.items.length) {
    const upgradePackagePoliciesResults = await packagePolicyService.bulkUpgrade(
      savedObjectsClient,
      esClient,
      policyIdsToUpgrade.items
    );
    const errors = upgradePackagePoliciesResults
      .filter((result) => !result.success)
      .map((result) => `${result.statusCode}: ${result.body?.message ?? ''}`);
    if (errors.length) {
      throw new Error(`Package policies upgrade for ${pkgName} failed:\n${errors.join('\n')}`);
    }
  }
}

export async function scheduleBulkUpgrade(
  taskManagerStart: TaskManagerStartContract,
  taskParams: Omit<BulkUpgradeTaskParams, 'type'>
) {
  return scheduleBulkOperationTask(taskManagerStart, { ...taskParams, type: 'bulk_upgrade' });
}
