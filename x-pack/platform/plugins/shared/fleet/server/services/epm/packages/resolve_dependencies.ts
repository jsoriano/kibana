/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import semverSatisfies from 'semver/functions/satisfies';
import semverIntersects from 'semver/ranges/intersects';
import semverValidRange from 'semver/ranges/valid';
import semverMaxSatisfying from 'semver/ranges/max-satisfying';
import type { Logger, SavedObjectsClientContract } from '@kbn/core/server';

import type {
  PackageConstraint,
  PackageRequirements,
} from '../../../../common/types/models/package_spec';
import type { Installation, ArchivePackage, RegistryPackage } from '../../../../common/types';

import {
  PackageDependencyConflictError,
  PackageDependencyCycleError,
  PackageDependencyValidationError,
} from '../../../errors';

import * as Registry from '../registry';

import { getInstallationsByName } from './get';

// ============================================================================
// Public Types
// ============================================================================

/**
 * Represents a package with its requirements (dependencies) for resolution.
 */
export interface PackageWithDependencies {
  /** Package name */
  name: string;
  /** Package version */
  version: string;
  /** Combined dependencies from requires.input and requires.content */
  dependencies?: PackageConstraint[];
  /** Original requires structure for type-aware operations */
  requires?: PackageRequirements;
}

/**
 * Represents a package constraint requirement from another package.
 */
export interface PackageConstraint {
  /** The name of the package that has this constraint */
  requiredBy: string;
  /** The version of the package that has this constraint */
  requiredByVersion: string;
  /** The semver constraint on the dependency */
  constraint: string;
}

/**
 * A conflict where multiple packages require incompatible versions of a dependency.
 */
export interface DependencyConflict {
  /** The name of the package that has conflicting requirements */
  dependency: string;
  /** The constraints from different packages */
  constraints: PackageConstraint[];
  /** Human-readable message describing the conflict */
  message: string;
}

/**
 * Result of dependency resolution.
 */
export interface DependencyResolutionResult {
  /** Whether all dependencies can be satisfied */
  success: boolean;
  /** If success: ordered list of packages to install (dependencies first) */
  installOrder?: Array<{ name: string; version: string }>;
  /** If failure: list of conflicts that prevent installation */
  conflicts?: DependencyConflict[];
  /** If failure due to cycle: the packages involved in the cycle */
  cycle?: string[];
}

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Internal node for building the dependency graph.
 */
interface DependencyNode {
  name: string;
  version: string;
  dependencies: PackageConstraint[];
  /** Constraints on this package from other packages */
  constraints: PackageConstraint[];
}

/**
 * Result of constraint compatibility check.
 */
interface ConstraintCompatibilityResult {
  compatible: boolean;
  /** A representative constraint that can be used to find satisfying versions */
  representativeConstraint?: string;
}

// ============================================================================
// Graph Building
// ============================================================================

/**
 * Build a dependency graph from installed packages and packages to be installed.
 *
 * @param installedPackages - Currently installed packages
 * @param packagesToInstall - Packages that will be installed (these override installed versions)
 * @returns A map of package names to dependency nodes
 */
function buildDependencyGraph(
  installedPackages: Installation[],
  packagesToInstall: PackageWithDependencies[]
): Map<string, DependencyNode> {
  const graph = new Map<string, DependencyNode>();

  // Add installed packages to the graph (skip those being replaced)
  for (const pkg of installedPackages) {
    if (packagesToInstall.some((p) => p.name === pkg.name)) {
      continue;
    }

    graph.set(pkg.name, {
      name: pkg.name,
      version: pkg.version,
      dependencies: [],
      constraints: [],
    });
  }

  // Add packages to install to the graph
  for (const pkg of packagesToInstall) {
    graph.set(pkg.name, {
      name: pkg.name,
      version: pkg.version,
      dependencies: pkg.dependencies || [],
      constraints: [],
    });
  }

  // Build constraints: for each package, record what other packages require of it
  for (const [, node] of graph) {
    for (const dep of node.dependencies) {
      const depNode = graph.get(dep.name);
      const constraint: PackageConstraint = {
        requiredBy: node.name,
        requiredByVersion: node.version,
        constraint: dep.version,
      };

      if (depNode) {
        depNode.constraints.push(constraint);
      } else {
        // Dependency not in graph - it needs to be installed
        graph.set(dep.name, {
          name: dep.name,
          version: '', // Version to be resolved
          dependencies: [],
          constraints: [constraint],
        });
      }
    }
  }

  return graph;
}

// ============================================================================
// Constraint Checking
// ============================================================================

/**
 * Check if all constraints on a package can be satisfied by a single version.
 *
 * @param constraints - Array of constraints from different packages
 * @returns Whether the constraints are compatible and a representative constraint
 */
function checkConstraintCompatibility(
  constraints: PackageConstraint[]
): ConstraintCompatibilityResult {
  if (constraints.length === 0) {
    return { compatible: true };
  }

  if (constraints.length === 1) {
    return { compatible: true, representativeConstraint: constraints[0].constraint };
  }

  // Check if all constraints can intersect (have a common satisfying version range)
  for (let i = 0; i < constraints.length; i++) {
    for (let j = i + 1; j < constraints.length; j++) {
      const range1 = constraints[i].constraint;
      const range2 = constraints[j].constraint;

      if (!semverValidRange(range1) || !semverValidRange(range2)) {
        return { compatible: false };
      }

      if (!semverIntersects(range1, range2)) {
        return { compatible: false };
      }
    }
  }

  // All constraints are compatible - return the first one as representative
  return { compatible: true, representativeConstraint: constraints[0].constraint };
}

/**
 * Check if a specific version satisfies all constraints.
 *
 * @param version - The version to check
 * @param constraints - Array of constraints to satisfy
 * @returns Whether the version satisfies all constraints
 *
 * @example
 * ```ts
 * const constraints = [
 *   { requiredBy: 'pkg1', requiredByVersion: '1.0.0', constraint: '^1.0.0' },
 *   { requiredBy: 'pkg2', requiredByVersion: '2.0.0', constraint: '>=1.0.0 <2.0.0' },
 * ];
 * versionSatisfiesAllConstraints('1.5.0', constraints); // true
 * ```
 */
export function versionSatisfiesAllConstraints(
  version: string,
  constraints: PackageConstraint[]
): boolean {
  return constraints.every((c) => semverSatisfies(version, c.constraint));
}

// ============================================================================
// Cycle Detection
// ============================================================================

/**
 * Detect cycles in the dependency graph using depth-first search.
 *
 * @param graph - The dependency graph to check
 * @returns The cycle path if found, or null if no cycles exist
 */
function detectCycles(graph: Map<string, DependencyNode>): string[] | null {
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(nodeName: string): string[] | null {
    visited.add(nodeName);
    recursionStack.add(nodeName);
    path.push(nodeName);

    const node = graph.get(nodeName);
    if (node) {
      for (const dep of node.dependencies) {
        if (!visited.has(dep.name)) {
          const cycle = dfs(dep.name);
          if (cycle) return cycle;
        } else if (recursionStack.has(dep.name)) {
          const cycleStart = path.indexOf(dep.name);
          return path.slice(cycleStart).concat(dep.name);
        }
      }
    }

    path.pop();
    recursionStack.delete(nodeName);
    return null;
  }

  for (const [nodeName] of graph) {
    if (!visited.has(nodeName)) {
      const cycle = dfs(nodeName);
      if (cycle) return cycle;
    }
  }

  return null;
}

// ============================================================================
// Conflict Detection
// ============================================================================

/**
 * Create a conflict message for incompatible constraints.
 */
function createIncompatibleConstraintsConflict(
  pkgName: string,
  constraints: PackageConstraint[]
): DependencyConflict {
  return {
    dependency: pkgName,
    constraints,
    message: `Package "${pkgName}" has incompatible version requirements:\n${constraints
      .map((c) => `  - ${c.requiredBy}@${c.requiredByVersion} requires ${pkgName} ${c.constraint}`)
      .join('\n')}`,
  };
}

/**
 * Create a conflict message for version not satisfying constraints.
 */
function createVersionMismatchConflict(
  pkgName: string,
  version: string,
  unsatisfiedConstraints: PackageConstraint[]
): DependencyConflict {
  return {
    dependency: pkgName,
    constraints: unsatisfiedConstraints,
    message: `Package "${pkgName}@${version}" does not satisfy version requirements:\n${unsatisfiedConstraints
      .map((c) => `  - ${c.requiredBy}@${c.requiredByVersion} requires ${pkgName} ${c.constraint}`)
      .join('\n')}`,
  };
}

/**
 * Create a conflict message for unavailable version.
 */
function createNoAvailableVersionConflict(
  pkgName: string,
  constraint: string,
  availableVersions: string[],
  constraints: PackageConstraint[]
): DependencyConflict {
  return {
    dependency: pkgName,
    constraints,
    message: `No available version of "${pkgName}" satisfies constraint ${constraint}. Available versions: ${availableVersions.join(
      ', '
    )}`,
  };
}

/**
 * Detect version conflicts in the dependency graph.
 *
 * @param graph - The dependency graph to check
 * @param availableVersions - Optional map of available versions for uninstalled dependencies
 * @returns Array of conflicts found
 */
function detectVersionConflicts(
  graph: Map<string, DependencyNode>,
  availableVersions?: Map<string, string[]>
): DependencyConflict[] {
  const conflicts: DependencyConflict[] = [];

  for (const [pkgName, node] of graph) {
    // Check multiple constraint compatibility
    if (node.constraints.length > 1) {
      const { compatible } = checkConstraintCompatibility(node.constraints);
      if (!compatible) {
        conflicts.push(createIncompatibleConstraintsConflict(pkgName, node.constraints));
        continue;
      }
    }

    // Check if installed/to-be-installed version satisfies all constraints
    if (node.version && node.constraints.length > 0) {
      if (!versionSatisfiesAllConstraints(node.version, node.constraints)) {
        const unsatisfiedConstraints = node.constraints.filter(
          (c) => !semverSatisfies(node.version, c.constraint)
        );
        conflicts.push(
          createVersionMismatchConflict(pkgName, node.version, unsatisfiedConstraints)
        );
        continue;
      }
    }

    // Check if unresolved dependency can be satisfied
    if (!node.version && node.constraints.length > 0) {
      const { compatible, representativeConstraint } = checkConstraintCompatibility(
        node.constraints
      );

      if (!compatible) {
        conflicts.push(createIncompatibleConstraintsConflict(pkgName, node.constraints));
      } else if (availableVersions && representativeConstraint) {
        const versions = availableVersions.get(pkgName);
        if (versions) {
          const satisfyingVersion = semverMaxSatisfying(versions, representativeConstraint);
          if (satisfyingVersion) {
            node.version = satisfyingVersion;
          } else {
            conflicts.push(
              createNoAvailableVersionConflict(
                pkgName,
                representativeConstraint,
                versions,
                node.constraints
              )
            );
          }
        }
      }
    }
  }

  return conflicts;
}

// ============================================================================
// Topological Sort
// ============================================================================

/**
 * Topologically sort packages so dependencies come before dependents.
 *
 * @param graph - The dependency graph
 * @param packagesToInstall - Set of package names that need to be installed
 * @returns Sorted list of package names
 */
function topologicalSort(
  graph: Map<string, DependencyNode>,
  packagesToInstall: Set<string>
): string[] {
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(nodeName: string) {
    if (visited.has(nodeName)) return;
    visited.add(nodeName);

    const node = graph.get(nodeName);
    if (node) {
      for (const dep of node.dependencies) {
        visit(dep.name);
      }
    }

    if (packagesToInstall.has(nodeName)) {
      result.push(nodeName);
    }
  }

  for (const pkgName of packagesToInstall) {
    visit(pkgName);
  }

  return result;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate that a package's dependencies have valid semver constraints.
 *
 * @param pkg - The package to validate
 * @throws {PackageDependencyValidationError} If any dependency is invalid
 *
 * @example
 * ```ts
 * validateDependencies({
 *   name: 'nginx',
 *   version: '1.0.0',
 *   dependencies: [
 *     { name: 'apache', version: '^1.0.0' },
 *   ],
 * }); // passes
 * ```
 */
export function validateDependencies(pkg: PackageWithDependencies): void {
  if (!pkg.dependencies) return;

  for (const dep of pkg.dependencies) {
    if (!dep.name || typeof dep.name !== 'string') {
      throw new PackageDependencyValidationError(
        `Invalid dependency in package ${pkg.name}: dependency name is required`
      );
    }

    if (!dep.version || typeof dep.version !== 'string') {
      throw new PackageDependencyValidationError(
        `Invalid dependency in package ${pkg.name}: version constraint is required for dependency ${dep.name}`
      );
    }

    if (!semverValidRange(dep.version)) {
      throw new PackageDependencyValidationError(
        `Invalid semver range "${dep.version}" for dependency ${dep.name} in package ${pkg.name}`
      );
    }

    if (dep.name === pkg.name) {
      throw new PackageDependencyValidationError(`Package ${pkg.name} cannot depend on itself`);
    }
  }
}

// ============================================================================
// Main Resolution Function
// ============================================================================

/**
 * Resolve dependencies for a set of packages to be installed.
 *
 * This function performs the following steps:
 * 1. Validates all dependency constraints are valid semver ranges
 * 2. Builds a dependency graph from installed and to-be-installed packages
 * 3. Detects circular dependencies
 * 4. Checks for version conflicts
 * 5. Returns a topologically sorted installation order (dependencies first)
 *
 * @param installedPackages - Currently installed packages
 * @param packagesToInstall - Packages that should be installed (with their dependencies)
 * @param availableVersions - Optional map of package names to available versions
 * @returns Resolution result with install order or conflict/cycle information
 *
 * @example
 * ```ts
 * const result = resolveDependencies(
 *   [{ name: 'filebeat', version: '1.5.0', ... }],
 *   [{ name: 'nginx', version: '1.0.0', dependencies: [{ name: 'filebeat', version: '^1.0.0' }] }]
 * );
 *
 * if (result.success) {
 *   console.log('Install order:', result.installOrder);
 * } else if (result.cycle) {
 *   console.error('Cycle detected:', result.cycle);
 * } else {
 *   console.error('Conflicts:', result.conflicts);
 * }
 * ```
 */
export function resolveDependencies(
  installedPackages: Installation[],
  packagesToInstall: PackageWithDependencies[],
  availableVersions?: Map<string, string[]>
): DependencyResolutionResult {
  // Step 1: Validate all dependencies
  for (const pkg of packagesToInstall) {
    validateDependencies(pkg);
  }

  // Step 2: Build the dependency graph
  const graph = buildDependencyGraph(installedPackages, packagesToInstall);

  // Step 3: Detect cycles
  const cycle = detectCycles(graph);
  if (cycle) {
    return { success: false, cycle };
  }

  // Step 4: Check for conflicts
  const conflicts = detectVersionConflicts(graph, availableVersions);
  if (conflicts.length > 0) {
    return { success: false, conflicts };
  }

  // Step 5: Determine which packages need to be installed
  const packagesToInstallSet = new Set<string>(packagesToInstall.map((p) => p.name));

  // Add unresolved dependencies that need to be installed
  for (const [pkgName, node] of graph) {
    if (node.constraints.length > 0 && !installedPackages.some((p) => p.name === pkgName)) {
      packagesToInstallSet.add(pkgName);
    }
  }

  // Step 6: Get topologically sorted install order
  const installOrder = topologicalSort(graph, packagesToInstallSet);

  return {
    success: true,
    installOrder: installOrder.map((name) => {
      const node = graph.get(name)!;
      return { name, version: node.version };
    }),
  };
}

// ============================================================================
// Removal Check
// ============================================================================

/**
 * Check if uninstalling a package would break dependencies of other installed packages.
 *
 * @param packageToRemove - Name of the package to remove
 * @param installedPackages - All currently installed packages with their dependencies
 * @returns List of packages that depend on the package being removed
 *
 * @example
 * ```ts
 * const dependents = checkDependentsBeforeRemoval('filebeat', installedPackages);
 * if (dependents.length > 0) {
 *   console.error('Cannot remove, required by:', dependents);
 * }
 * ```
 */
export function checkDependentsBeforeRemoval(
  packageToRemove: string,
  installedPackages: Array<{ name: string; version: string; dependencies?: PackageConstraint[] }>
): Array<{ name: string; version: string }> {
  const dependents: Array<{ name: string; version: string }> = [];

  for (const pkg of installedPackages) {
    if (pkg.name === packageToRemove) continue;

    if (pkg.dependencies?.some((dep) => dep.name === packageToRemove)) {
      dependents.push({ name: pkg.name, version: pkg.version });
    }
  }

  return dependents;
}

// ============================================================================
// Async Helpers
// ============================================================================

/**
 * Async helper to resolve dependencies with package info fetching.
 * This retrieves the installed packages and validates the installation plan.
 *
 * @param options - Resolution options
 * @returns Resolution result
 */
export async function resolvePackageDependencies(options: {
  savedObjectsClient: SavedObjectsClientContract;
  packagesToInstall: PackageWithDependencies[];
  fetchAvailableVersions?: (pkgName: string) => Promise<string[]>;
}): Promise<DependencyResolutionResult> {
  const { savedObjectsClient, packagesToInstall, fetchAvailableVersions } = options;

  // Collect all package names we need to check
  const packageNames = collectAllPackageNames(packagesToInstall);

  // Fetch installed packages
  const installations = await getInstallationsByName({
    savedObjectsClient,
    pkgNames: Array.from(packageNames),
  });

  // Fetch available versions for uninstalled dependencies if callback provided
  let availableVersions: Map<string, string[]> | undefined;
  if (fetchAvailableVersions) {
    availableVersions = await fetchAvailableVersionsForUninstalledDeps(
      packagesToInstall,
      installations,
      fetchAvailableVersions
    );
  }

  return resolveDependencies(installations, packagesToInstall, availableVersions);
}

/**
 * Collect all package names from packages and their dependencies.
 */
function collectAllPackageNames(packages: PackageWithDependencies[]): Set<string> {
  const names = new Set<string>();

  for (const pkg of packages) {
    names.add(pkg.name);
    if (pkg.dependencies) {
      for (const dep of pkg.dependencies) {
        names.add(dep.name);
      }
    }
  }

  return names;
}

/**
 * Fetch available versions for dependencies that are not installed.
 */
async function fetchAvailableVersionsForUninstalledDeps(
  packagesToInstall: PackageWithDependencies[],
  installations: Installation[],
  fetchAvailableVersions: (pkgName: string) => Promise<string[]>
): Promise<Map<string, string[]>> {
  const availableVersions = new Map<string, string[]>();
  const uninstalledDeps = new Set<string>();

  for (const pkg of packagesToInstall) {
    if (pkg.dependencies) {
      for (const dep of pkg.dependencies) {
        const isInstalled = installations.some((i) => i.name === dep.name);
        const willBeInstalled = packagesToInstall.some((p) => p.name === dep.name);
        if (!isInstalled && !willBeInstalled) {
          uninstalledDeps.add(dep.name);
        }
      }
    }
  }

  for (const depName of uninstalledDeps) {
    try {
      const versions = await fetchAvailableVersions(depName);
      availableVersions.set(depName, versions);
    } catch {
      // If we can't fetch versions, the resolution will fail with appropriate error
    }
  }

  return availableVersions;
}

// ============================================================================
// Conversion Helpers
// ============================================================================

/**
 * Convert package info to PackageWithDependencies format.
 *
 * Merges requires.input and requires.content into a single dependencies array
 * for resolution, while preserving the original requires structure.
 *
 * @param packageInfo - The package info from registry or archive
 * @returns Package with dependencies in resolution format
 */
export function packageInfoToPackageWithDependencies(
  packageInfo: ArchivePackage | RegistryPackage
): PackageWithDependencies {
  const requires = packageInfo.requires;
  const dependencies: PackageConstraint[] = [
    ...(requires?.input || []),
    ...(requires?.content || []),
  ];

  return {
    name: packageInfo.name,
    version: packageInfo.version,
    dependencies: dependencies.length > 0 ? dependencies : undefined,
    requires,
  };
}

// ============================================================================
// Error Helpers
// ============================================================================

/**
 * Throws appropriate errors based on resolution result.
 *
 * @param result - The resolution result to check
 * @throws {PackageDependencyCycleError} If a cycle was detected
 * @throws {PackageDependencyConflictError} If conflicts were found
 */
export function throwOnResolutionFailure(result: DependencyResolutionResult): void {
  if (result.success) return;

  if (result.cycle) {
    throw new PackageDependencyCycleError(
      `Circular dependency detected: ${result.cycle.join(' -> ')}`
    );
  }

  if (result.conflicts && result.conflicts.length > 0) {
    const messages = result.conflicts.map((c) => c.message).join('\n\n');
    throw new PackageDependencyConflictError(
      `Cannot install packages due to dependency conflicts:\n\n${messages}`
    );
  }
}

// ============================================================================
// Bulk Install Pre-Validation (Shared Helper)
// ============================================================================

/**
 * Pre-validate dependencies across multiple packages before starting bulk installation.
 *
 * This function is used by bulk_install_packages.ts, run_bulk_upgrade.ts, and can be
 * used by other bulk operations. It fetches package info for all packages, builds
 * the dependency graph, and throws if there are conflicts or cycles.
 *
 * @param options - Validation options
 * @throws {PackageDependencyCycleError} If a cycle is detected
 * @throws {PackageDependencyConflictError} If conflicts are found
 *
 * @example
 * ```ts
 * await preValidateBulkInstallDependencies({
 *   savedObjectsClient,
 *   packages: [{ name: 'nginx', version: '1.0.0' }, { name: 'apache', version: '2.0.0' }],
 *   logger,
 * });
 * // If no error thrown, safe to proceed with installation
 * ```
 */
export async function preValidateBulkInstallDependencies(options: {
  savedObjectsClient: SavedObjectsClientContract;
  packages: Array<{ name: string; version: string }>;
  logger: Logger;
}): Promise<void> {
  const { savedObjectsClient, packages, logger } = options;

  // Fetch package info with dependencies for all packages
  const packagesWithDeps: PackageWithDependencies[] = await Promise.all(
    packages.map(async (pkg) => {
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

  if (!hasAnyDependencies) {
    return;
  }

  // Get all installed packages
  const allPackageNames = collectAllPackageNames(packagesWithDeps);

  const installedPackages = await getInstallationsByName({
    savedObjectsClient,
    pkgNames: Array.from(allPackageNames),
  });

  const resolution = resolveDependencies(installedPackages, packagesWithDeps);

  // This will throw if there are conflicts or cycles
  throwOnResolutionFailure(resolution);

  logger.debug(
    `Dependency resolution successful. Install order: ${resolution.installOrder
      ?.map((p) => `${p.name}@${p.version}`)
      .join(' -> ')}`
  );
}
