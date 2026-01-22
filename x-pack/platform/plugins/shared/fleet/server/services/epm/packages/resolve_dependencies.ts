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
import type { SavedObjectsClientContract } from '@kbn/core/server';

import type {
  PackageDependency,
  PackageRequirements,
} from '../../../../common/types/models/package_spec';
import type { Installation, ArchivePackage, RegistryPackage } from '../../../../common/types';

import {
  PackageDependencyConflictError,
  PackageDependencyCycleError,
  PackageDependencyValidationError,
} from '../../../errors';

import { getInstallationsByName } from './get';

/**
 * Represents a package with its requirements (dependencies) for resolution
 */
export interface PackageWithDependencies {
  name: string;
  version: string;
  /** Combined dependencies from requires.input and requires.content */
  dependencies?: PackageDependency[];
  /** Original requires structure for type-aware operations */
  requires?: PackageRequirements;
}

/**
 * Represents a package constraint requirement from another package
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
 * A conflict where multiple packages require incompatible versions of a dependency
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
 * Result of dependency resolution
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

/**
 * Internal node for building the dependency graph
 */
interface DependencyNode {
  name: string;
  version: string;
  dependencies: PackageDependency[];
  /** Constraints on this package from other packages */
  constraints: PackageConstraint[];
}

/**
 * Build a dependency graph from installed packages and packages to be installed
 */
function buildDependencyGraph(
  installedPackages: Installation[],
  packagesToInstall: PackageWithDependencies[]
): Map<string, DependencyNode> {
  const graph = new Map<string, DependencyNode>();

  // Add installed packages to the graph
  for (const pkg of installedPackages) {
    // Skip packages that will be replaced by installation
    if (packagesToInstall.some((p) => p.name === pkg.name)) {
      continue;
    }

    graph.set(pkg.name, {
      name: pkg.name,
      version: pkg.version,
      // Installed packages don't have dependencies in the Installation type,
      // they would need to be fetched separately if needed
      dependencies: [],
      constraints: [],
    });
  }

  // Add packages to install to the graph (overriding if already installed)
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
      if (depNode) {
        depNode.constraints.push({
          requiredBy: node.name,
          requiredByVersion: node.version,
          constraint: dep.version,
        });
      } else {
        // Dependency not in graph - it needs to be installed
        graph.set(dep.name, {
          name: dep.name,
          version: '', // Version to be resolved
          dependencies: [],
          constraints: [
            {
              requiredBy: node.name,
              requiredByVersion: node.version,
              constraint: dep.version,
            },
          ],
        });
      }
    }
  }

  return graph;
}

/**
 * Check if all constraints on a package can be satisfied by a single version
 */
function checkConstraintCompatibility(constraints: PackageConstraint[]): {
  compatible: boolean;
  mergedConstraint?: string;
} {
  if (constraints.length === 0) {
    return { compatible: true };
  }

  if (constraints.length === 1) {
    return { compatible: true, mergedConstraint: constraints[0].constraint };
  }

  // Check if all constraints can intersect (have a common satisfying version range)
  for (let i = 0; i < constraints.length; i++) {
    for (let j = i + 1; j < constraints.length; j++) {
      const range1 = constraints[i].constraint;
      const range2 = constraints[j].constraint;

      // Validate ranges
      if (!semverValidRange(range1) || !semverValidRange(range2)) {
        return { compatible: false };
      }

      // Check if ranges intersect
      if (!semverIntersects(range1, range2)) {
        return { compatible: false };
      }
    }
  }

  // All constraints are compatible - return the most restrictive (first one for simplicity)
  return { compatible: true, mergedConstraint: constraints[0].constraint };
}

/**
 * Check if a specific version satisfies all constraints
 */
export function versionSatisfiesAllConstraints(
  version: string,
  constraints: PackageConstraint[]
): boolean {
  return constraints.every((c) => semverSatisfies(version, c.constraint));
}

/**
 * Detect cycles in the dependency graph using DFS
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
          // Found a cycle - return the cycle path
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

/**
 * Topologically sort packages so dependencies come before dependents
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

    // Only include packages that need to be installed
    if (packagesToInstall.has(nodeName)) {
      result.push(nodeName);
    }
  }

  for (const pkgName of packagesToInstall) {
    visit(pkgName);
  }

  return result;
}

/**
 * Validate that a package's dependencies have valid semver constraints
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

    // Prevent self-dependency
    if (dep.name === pkg.name) {
      throw new PackageDependencyValidationError(
        `Package ${pkg.name} cannot depend on itself`
      );
    }
  }
}

/**
 * Resolve dependencies for a set of packages to be installed.
 *
 * This function:
 * 1. Validates all dependency constraints are valid semver ranges
 * 2. Checks for conflicts where different packages require incompatible versions
 * 3. Detects circular dependencies
 * 4. Returns a topologically sorted installation order (dependencies first)
 *
 * @param installedPackages Currently installed packages
 * @param packagesToInstall Packages that should be installed (with their dependencies)
 * @param availableVersions Optional map of package names to available versions (for resolving uninstalled deps)
 * @returns Resolution result with install order or conflict information
 */
export function resolveDependencies(
  installedPackages: Installation[],
  packagesToInstall: PackageWithDependencies[],
  availableVersions?: Map<string, string[]>
): DependencyResolutionResult {
  // Validate all dependencies first
  for (const pkg of packagesToInstall) {
    validateDependencies(pkg);
  }

  // Build the dependency graph
  const graph = buildDependencyGraph(installedPackages, packagesToInstall);

  // Detect cycles
  const cycle = detectCycles(graph);
  if (cycle) {
    return {
      success: false,
      cycle,
    };
  }

  // Check for conflicts
  const conflicts: DependencyConflict[] = [];

  for (const [pkgName, node] of graph) {
    if (node.constraints.length > 1) {
      const { compatible } = checkConstraintCompatibility(node.constraints);

      if (!compatible) {
        conflicts.push({
          dependency: pkgName,
          constraints: node.constraints,
          message: `Package "${pkgName}" has incompatible version requirements:\n${node.constraints
            .map((c) => `  - ${c.requiredBy}@${c.requiredByVersion} requires ${pkgName} ${c.constraint}`)
            .join('\n')}`,
        });
      }
    }

    // Check if installed/to-be-installed version satisfies all constraints
    if (node.version && node.constraints.length > 0) {
      if (!versionSatisfiesAllConstraints(node.version, node.constraints)) {
        // Find which constraints are not satisfied
        const unsatisfiedConstraints = node.constraints.filter(
          (c) => !semverSatisfies(node.version, c.constraint)
        );

        conflicts.push({
          dependency: pkgName,
          constraints: unsatisfiedConstraints,
          message: `Package "${pkgName}@${node.version}" does not satisfy version requirements:\n${unsatisfiedConstraints
            .map((c) => `  - ${c.requiredBy}@${c.requiredByVersion} requires ${pkgName} ${c.constraint}`)
            .join('\n')}`,
        });
      }
    }

    // Check if unresolved dependency (version is empty) can be satisfied
    if (!node.version && node.constraints.length > 0) {
      const { compatible, mergedConstraint } = checkConstraintCompatibility(node.constraints);

      if (!compatible) {
        conflicts.push({
          dependency: pkgName,
          constraints: node.constraints,
          message: `Package "${pkgName}" has incompatible version requirements:\n${node.constraints
            .map((c) => `  - ${c.requiredBy}@${c.requiredByVersion} requires ${pkgName} ${c.constraint}`)
            .join('\n')}`,
        });
      } else if (availableVersions) {
        // Try to find a satisfying version
        const versions = availableVersions.get(pkgName);
        if (versions && mergedConstraint) {
          const satisfyingVersion = semverMaxSatisfying(versions, mergedConstraint);
          if (satisfyingVersion) {
            node.version = satisfyingVersion;
          } else {
            conflicts.push({
              dependency: pkgName,
              constraints: node.constraints,
              message: `No available version of "${pkgName}" satisfies constraint ${mergedConstraint}. Available versions: ${versions.join(', ')}`,
            });
          }
        }
      }
    }
  }

  if (conflicts.length > 0) {
    return {
      success: false,
      conflicts,
    };
  }

  // Determine which packages need to be installed
  const packagesToInstallSet = new Set<string>(packagesToInstall.map((p) => p.name));

  // Add unresolved dependencies that need to be installed
  for (const [pkgName, node] of graph) {
    if (node.constraints.length > 0 && !installedPackages.some((p) => p.name === pkgName)) {
      packagesToInstallSet.add(pkgName);
    }
  }

  // Get topologically sorted install order
  const installOrder = topologicalSort(graph, packagesToInstallSet);

  return {
    success: true,
    installOrder: installOrder.map((name) => {
      const node = graph.get(name)!;
      return { name, version: node.version };
    }),
  };
}

/**
 * Check if uninstalling a package would break dependencies of other installed packages.
 *
 * @param packageToRemove Name of the package to remove
 * @param installedPackages All currently installed packages with their dependencies
 * @returns List of packages that depend on the package being removed
 */
export function checkDependentsBeforeRemoval(
  packageToRemove: string,
  installedPackages: Array<{ name: string; version: string; dependencies?: PackageDependency[] }>
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

/**
 * Async helper to resolve dependencies with package info fetching.
 * This retrieves the installed packages and validates the installation plan.
 */
export async function resolvePackageDependencies(options: {
  savedObjectsClient: SavedObjectsClientContract;
  packagesToInstall: PackageWithDependencies[];
  fetchAvailableVersions?: (pkgName: string) => Promise<string[]>;
}): Promise<DependencyResolutionResult> {
  const { savedObjectsClient, packagesToInstall, fetchAvailableVersions } = options;

  // Get all installed packages
  const installedPackageNames = new Set<string>();

  // Collect all package names we need to check (installed + to install + dependencies)
  for (const pkg of packagesToInstall) {
    installedPackageNames.add(pkg.name);
    if (pkg.dependencies) {
      for (const dep of pkg.dependencies) {
        installedPackageNames.add(dep.name);
      }
    }
  }

  // Fetch installed packages
  const installations = await getInstallationsByName({
    savedObjectsClient,
    pkgNames: Array.from(installedPackageNames),
  });

  // Fetch available versions for uninstalled dependencies if callback provided
  let availableVersions: Map<string, string[]> | undefined;
  if (fetchAvailableVersions) {
    availableVersions = new Map();
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
  }

  return resolveDependencies(installations, packagesToInstall, availableVersions);
}

/**
 * Convert package info to PackageWithDependencies format.
 * Merges requires.input and requires.content into a single dependencies array for resolution,
 * while preserving the original requires structure.
 */
export function packageInfoToPackageWithDependencies(
  packageInfo: ArchivePackage | RegistryPackage
): PackageWithDependencies {
  const requires = packageInfo.requires;
  const dependencies: PackageDependency[] = [
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

/**
 * Throws appropriate errors based on resolution result
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
