/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Installation } from '../../../../common/types';

import {
  PackageDependencyConflictError,
  PackageDependencyCycleError,
  PackageDependencyValidationError,
} from '../../../errors';

import {
  resolveDependencies,
  validateDependencies,
  checkDependentsBeforeRemoval,
  versionSatisfiesAllConstraints,
  throwOnResolutionFailure,
  packageInfoToPackageWithDependencies,
  type PackageWithDependencies,
} from './resolve_dependencies';

describe('resolve_dependencies', () => {
  describe('validateDependencies', () => {
    it('should pass for valid dependencies', () => {
      const pkg: PackageWithDependencies = {
        name: 'nginx',
        version: '1.0.0',
        dependencies: [
          { name: 'apache', version: '^1.0.0' },
          { name: 'elasticsearch', version: '>=7.0.0 <9.0.0' },
        ],
      };

      expect(() => validateDependencies(pkg)).not.toThrow();
    });

    it('should pass for package without dependencies', () => {
      const pkg: PackageWithDependencies = {
        name: 'nginx',
        version: '1.0.0',
      };

      expect(() => validateDependencies(pkg)).not.toThrow();
    });

    it('should throw for missing dependency name', () => {
      const pkg: PackageWithDependencies = {
        name: 'nginx',
        version: '1.0.0',
        dependencies: [{ name: '', version: '^1.0.0' }],
      };

      expect(() => validateDependencies(pkg)).toThrow(PackageDependencyValidationError);
    });

    it('should throw for missing version constraint', () => {
      const pkg: PackageWithDependencies = {
        name: 'nginx',
        version: '1.0.0',
        dependencies: [{ name: 'filebeat', version: '' }],
      };

      expect(() => validateDependencies(pkg)).toThrow(PackageDependencyValidationError);
    });

    it('should throw for invalid semver range', () => {
      const pkg: PackageWithDependencies = {
        name: 'nginx',
        version: '1.0.0',
        dependencies: [{ name: 'filebeat', version: 'not-a-valid-range' }],
      };

      expect(() => validateDependencies(pkg)).toThrow(PackageDependencyValidationError);
    });

    it('should throw for self-dependency', () => {
      const pkg: PackageWithDependencies = {
        name: 'nginx',
        version: '1.0.0',
        dependencies: [{ name: 'nginx', version: '^1.0.0' }],
      };

      expect(() => validateDependencies(pkg)).toThrow(PackageDependencyValidationError);
      expect(() => validateDependencies(pkg)).toThrow('cannot depend on itself');
    });
  });

  describe('versionSatisfiesAllConstraints', () => {
    it('should return true when version satisfies all constraints', () => {
      const constraints = [
        { requiredBy: 'pkg1', requiredByVersion: '1.0.0', constraint: '^1.0.0' },
        { requiredBy: 'pkg2', requiredByVersion: '2.0.0', constraint: '>=1.0.0 <2.0.0' },
      ];

      expect(versionSatisfiesAllConstraints('1.5.0', constraints)).toBe(true);
    });

    it('should return false when version does not satisfy all constraints', () => {
      const constraints = [
        { requiredBy: 'pkg1', requiredByVersion: '1.0.0', constraint: '^1.0.0' },
        { requiredBy: 'pkg2', requiredByVersion: '2.0.0', constraint: '^2.0.0' },
      ];

      expect(versionSatisfiesAllConstraints('1.5.0', constraints)).toBe(false);
    });

    it('should return true for empty constraints', () => {
      expect(versionSatisfiesAllConstraints('1.0.0', [])).toBe(true);
    });
  });

  describe('resolveDependencies', () => {
    const createInstallation = (name: string, version: string): Installation =>
      ({
        name,
        version,
        install_status: 'installed',
        installed_kibana: [],
        installed_es: [],
        es_index_patterns: {},
        install_version: version,
        install_started_at: new Date().toISOString(),
        install_source: 'registry',
        verification_status: 'verified',
      } as Installation);

    it('should resolve simple dependency', () => {
      const installedPackages: Installation[] = [createInstallation('filebeat', '1.5.0')];

      const packagesToInstall: PackageWithDependencies[] = [
        {
          name: 'nginx',
          version: '1.0.0',
          dependencies: [{ name: 'filebeat', version: '^1.0.0' }],
        },
      ];

      const result = resolveDependencies(installedPackages, packagesToInstall);

      expect(result.success).toBe(true);
      expect(result.installOrder).toEqual([{ name: 'nginx', version: '1.0.0' }]);
    });

    it('should detect conflict when packages require incompatible versions', () => {
      const installedPackages: Installation[] = [];

      const packagesToInstall: PackageWithDependencies[] = [
        {
          name: 'nginx',
          version: '1.0.0',
          dependencies: [{ name: 'filebeat', version: '^1.0.0' }],
        },
        {
          name: 'apache',
          version: '2.0.0',
          dependencies: [{ name: 'filebeat', version: '^2.0.0' }],
        },
      ];

      const result = resolveDependencies(installedPackages, packagesToInstall);

      expect(result.success).toBe(false);
      expect(result.conflicts).toBeDefined();
      expect(result.conflicts?.length).toBeGreaterThan(0);
      expect(result.conflicts?.[0].dependency).toBe('filebeat');
    });

    it('should detect when installed version does not satisfy constraint', () => {
      const installedPackages: Installation[] = [createInstallation('filebeat', '1.0.0')];

      const packagesToInstall: PackageWithDependencies[] = [
        {
          name: 'nginx',
          version: '1.0.0',
          dependencies: [{ name: 'filebeat', version: '^2.0.0' }],
        },
      ];

      const result = resolveDependencies(installedPackages, packagesToInstall);

      expect(result.success).toBe(false);
      expect(result.conflicts).toBeDefined();
      expect(result.conflicts?.[0].dependency).toBe('filebeat');
    });

    it('should detect circular dependencies', () => {
      const installedPackages: Installation[] = [];

      const packagesToInstall: PackageWithDependencies[] = [
        {
          name: 'pkg-a',
          version: '1.0.0',
          dependencies: [{ name: 'pkg-b', version: '^1.0.0' }],
        },
        {
          name: 'pkg-b',
          version: '1.0.0',
          dependencies: [{ name: 'pkg-c', version: '^1.0.0' }],
        },
        {
          name: 'pkg-c',
          version: '1.0.0',
          dependencies: [{ name: 'pkg-a', version: '^1.0.0' }],
        },
      ];

      const result = resolveDependencies(installedPackages, packagesToInstall);

      expect(result.success).toBe(false);
      expect(result.cycle).toBeDefined();
      expect(result.cycle?.length).toBeGreaterThan(0);
    });

    it('should return correct install order (dependencies first)', () => {
      const installedPackages: Installation[] = [];

      const packagesToInstall: PackageWithDependencies[] = [
        {
          name: 'app',
          version: '1.0.0',
          dependencies: [{ name: 'lib-a', version: '^1.0.0' }],
        },
        {
          name: 'lib-a',
          version: '1.0.0',
          dependencies: [{ name: 'lib-b', version: '^1.0.0' }],
        },
        {
          name: 'lib-b',
          version: '1.0.0',
        },
      ];

      const result = resolveDependencies(installedPackages, packagesToInstall);

      expect(result.success).toBe(true);
      expect(result.installOrder).toBeDefined();

      // lib-b should come before lib-a, which should come before app
      const order = result.installOrder!.map((p) => p.name);
      expect(order.indexOf('lib-b')).toBeLessThan(order.indexOf('lib-a'));
      expect(order.indexOf('lib-a')).toBeLessThan(order.indexOf('app'));
    });

    it('should allow compatible version ranges', () => {
      const installedPackages: Installation[] = [];

      const packagesToInstall: PackageWithDependencies[] = [
        {
          name: 'nginx',
          version: '1.0.0',
          dependencies: [{ name: 'filebeat', version: '>=1.0.0 <2.0.0' }],
        },
        {
          name: 'apache',
          version: '2.0.0',
          dependencies: [{ name: 'filebeat', version: '^1.5.0' }],
        },
        {
          name: 'filebeat',
          version: '1.8.0',
        },
      ];

      const result = resolveDependencies(installedPackages, packagesToInstall);

      expect(result.success).toBe(true);
    });

    it('should handle package with no dependencies', () => {
      const installedPackages: Installation[] = [];

      const packagesToInstall: PackageWithDependencies[] = [
        {
          name: 'simple-package',
          version: '1.0.0',
        },
      ];

      const result = resolveDependencies(installedPackages, packagesToInstall);

      expect(result.success).toBe(true);
      expect(result.installOrder).toEqual([{ name: 'simple-package', version: '1.0.0' }]);
    });

    it('should not include already installed packages in install order', () => {
      const installedPackages: Installation[] = [createInstallation('filebeat', '1.5.0')];

      const packagesToInstall: PackageWithDependencies[] = [
        {
          name: 'nginx',
          version: '1.0.0',
          dependencies: [{ name: 'filebeat', version: '^1.0.0' }],
        },
      ];

      const result = resolveDependencies(installedPackages, packagesToInstall);

      expect(result.success).toBe(true);
      expect(result.installOrder?.find((p) => p.name === 'filebeat')).toBeUndefined();
    });
  });

  describe('checkDependentsBeforeRemoval', () => {
    it('should return empty array when no packages depend on the target', () => {
      const installedPackages = [
        { name: 'nginx', version: '1.0.0', dependencies: [{ name: 'other', version: '^1.0.0' }] },
        { name: 'apache', version: '2.0.0' },
      ];

      const result = checkDependentsBeforeRemoval('filebeat', installedPackages);

      expect(result).toEqual([]);
    });

    it('should return packages that depend on the target', () => {
      const installedPackages = [
        {
          name: 'nginx',
          version: '1.0.0',
          dependencies: [{ name: 'filebeat', version: '^1.0.0' }],
        },
        {
          name: 'apache',
          version: '2.0.0',
          dependencies: [{ name: 'filebeat', version: '^1.0.0' }],
        },
        { name: 'mysql', version: '3.0.0' },
      ];

      const result = checkDependentsBeforeRemoval('filebeat', installedPackages);

      expect(result).toHaveLength(2);
      expect(result).toContainEqual({ name: 'nginx', version: '1.0.0' });
      expect(result).toContainEqual({ name: 'apache', version: '2.0.0' });
    });

    it('should not include the package being removed', () => {
      const installedPackages = [
        {
          name: 'filebeat',
          version: '1.0.0',
          dependencies: [{ name: 'filebeat', version: '^1.0.0' }],
        }, // self-reference (shouldn't happen but test anyway)
        { name: 'nginx', version: '1.0.0', dependencies: [{ name: 'filebeat', version: '^1.0.0' }] },
      ];

      const result = checkDependentsBeforeRemoval('filebeat', installedPackages);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('nginx');
    });
  });

  describe('throwOnResolutionFailure', () => {
    it('should not throw for successful resolution', () => {
      const result = {
        success: true,
        installOrder: [{ name: 'test', version: '1.0.0' }],
      };

      expect(() => throwOnResolutionFailure(result)).not.toThrow();
    });

    it('should throw PackageDependencyCycleError for cycle', () => {
      const result = {
        success: false,
        cycle: ['pkg-a', 'pkg-b', 'pkg-a'],
      };

      expect(() => throwOnResolutionFailure(result)).toThrow(PackageDependencyCycleError);
    });

    it('should throw PackageDependencyConflictError for conflicts', () => {
      const result = {
        success: false,
        conflicts: [
          {
            dependency: 'filebeat',
            constraints: [
              { requiredBy: 'nginx', requiredByVersion: '1.0.0', constraint: '^1.0.0' },
              { requiredBy: 'apache', requiredByVersion: '2.0.0', constraint: '^2.0.0' },
            ],
            message: 'Test conflict message',
          },
        ],
      };

      expect(() => throwOnResolutionFailure(result)).toThrow(PackageDependencyConflictError);
    });
  });

  describe('packageInfoToPackageWithDependencies', () => {
    it('should merge requires.input and requires.content into dependencies', () => {
      const packageInfo = {
        name: 'my-integration',
        version: '1.0.0',
        title: 'My Integration',
        owner: { github: 'elastic' },
        requires: {
          input: [
            { name: 'input-package-a', version: '^1.0.0' },
            { name: 'input-package-b', version: '^2.0.0' },
          ],
          content: [
            { name: 'content-package-a', version: '^1.0.0' },
          ],
        },
      } as any;

      const result = packageInfoToPackageWithDependencies(packageInfo);

      expect(result.name).toBe('my-integration');
      expect(result.version).toBe('1.0.0');
      expect(result.dependencies).toHaveLength(3);
      expect(result.dependencies).toContainEqual({ name: 'input-package-a', version: '^1.0.0' });
      expect(result.dependencies).toContainEqual({ name: 'input-package-b', version: '^2.0.0' });
      expect(result.dependencies).toContainEqual({ name: 'content-package-a', version: '^1.0.0' });
      expect(result.requires).toEqual(packageInfo.requires);
    });

    it('should handle package with only requires.input', () => {
      const packageInfo = {
        name: 'my-integration',
        version: '1.0.0',
        title: 'My Integration',
        owner: { github: 'elastic' },
        requires: {
          input: [{ name: 'input-package', version: '^1.0.0' }],
        },
      } as any;

      const result = packageInfoToPackageWithDependencies(packageInfo);

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies).toContainEqual({ name: 'input-package', version: '^1.0.0' });
    });

    it('should handle package with only requires.content', () => {
      const packageInfo = {
        name: 'my-integration',
        version: '1.0.0',
        title: 'My Integration',
        owner: { github: 'elastic' },
        requires: {
          content: [{ name: 'content-package', version: '^1.0.0' }],
        },
      } as any;

      const result = packageInfoToPackageWithDependencies(packageInfo);

      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies).toContainEqual({ name: 'content-package', version: '^1.0.0' });
    });

    it('should handle package without requires', () => {
      const packageInfo = {
        name: 'simple-package',
        version: '1.0.0',
        title: 'Simple Package',
        owner: { github: 'elastic' },
      } as any;

      const result = packageInfoToPackageWithDependencies(packageInfo);

      expect(result.name).toBe('simple-package');
      expect(result.version).toBe('1.0.0');
      expect(result.dependencies).toBeUndefined();
      expect(result.requires).toBeUndefined();
    });

    it('should handle package with empty requires', () => {
      const packageInfo = {
        name: 'empty-requires',
        version: '1.0.0',
        title: 'Empty Requires',
        owner: { github: 'elastic' },
        requires: {},
      } as any;

      const result = packageInfoToPackageWithDependencies(packageInfo);

      expect(result.dependencies).toBeUndefined();
    });

    it('should handle package with empty input and content arrays', () => {
      const packageInfo = {
        name: 'empty-arrays',
        version: '1.0.0',
        title: 'Empty Arrays',
        owner: { github: 'elastic' },
        requires: {
          input: [],
          content: [],
        },
      } as any;

      const result = packageInfoToPackageWithDependencies(packageInfo);

      expect(result.dependencies).toBeUndefined();
    });
  });
});
