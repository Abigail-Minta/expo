/**
 * Copyright © 2023 650 Industries.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import fs from 'fs';
import { MixedOutput, Module, ReadOnlyGraph, SerializerOptions } from 'metro';
import { minimatch } from 'minimatch';
import path from 'path';

import { isShakingEnabled } from './treeShakeSerializerPlugin';
import { SerializerParameters } from './withExpoSerializers';

// const debug = require('debug')('expo:metro-config:serializer:side-effects') as typeof console.log;

export function hasSideEffect(
  graph: ReadOnlyGraph,
  value: Module<MixedOutput>,
  checked: Set<string> = new Set()
): boolean {
  // @ts-expect-error: Not on type.
  if (value.sideEffects) {
    return true;
  }
  // Recursively check if any of the dependencies have side effects.
  for (const depReference of value.dependencies.values()) {
    if (checked.has(depReference.absolutePath)) {
      continue;
    }
    checked.add(depReference.absolutePath);
    const dep = graph.dependencies.get(depReference.absolutePath)!;
    if (hasSideEffect(graph, dep, checked)) {
      return true;
    }
  }
  return false;
}

// Iterate the graph and mark dependencies as side-effect-ful if they are marked as such in the package.json.
export function sideEffectsSerializerPlugin(
  entryPoint: string,
  preModules: readonly Module<MixedOutput>[],
  graph: ReadOnlyGraph,
  options: SerializerOptions
): SerializerParameters {
  if (!isShakingEnabled(graph, options)) {
    return [entryPoint, preModules, graph, options];
  }

  const findUpPackageJsonPath = (dir: string): string | null => {
    if (dir === path.sep || dir.length < options.projectRoot.length) {
      return null;
    }
    const packageJsonPath = path.join(dir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      return packageJsonPath;
    }
    return findUpPackageJsonPath(path.dirname(dir));
  };

  const pkgJsonCache = new Map<string, any>();

  const getPackageJsonMatcher = (dir: string): any => {
    const cached = pkgJsonCache.get(dir);
    if (cached) {
      return cached;
    }
    const packageJsonPath = findUpPackageJsonPath(dir);
    if (!packageJsonPath) {
      return null;
    }
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

    // TODO: Split out and unit test.
    const dirRoot = path.dirname(packageJsonPath);
    const isSideEffect = (fp: string): boolean => {
      // Default is that everything is a side-effect unless explicitly marked as not.
      if (packageJson.sideEffects == null) {
        return true;
      }

      if (typeof packageJson.sideEffects === 'boolean') {
        return packageJson.sideEffects;
      } else if (Array.isArray(packageJson.sideEffects)) {
        const relativeName = path.relative(dirRoot, fp);
        return packageJson.sideEffects.some((sideEffect: any) => {
          if (typeof sideEffect === 'string') {
            return minimatch(relativeName, sideEffect.replace(/^\.\//, ''), {
              matchBase: true,
            });
          }
          return false;
        });
      }
      return false;
    };

    pkgJsonCache.set(dir, isSideEffect);
    return isSideEffect;
  };

  // This pass will traverse all dependencies and mark them as side-effect-ful if they are marked as such
  // in the package.json, according to Webpack: https://webpack.js.org/guides/tree-shaking/#mark-the-file-as-side-effect-free
  for (const value of graph.dependencies.values()) {
    const isSideEffect = getPackageJsonMatcher(value.path);
    if (!isSideEffect) {
      continue;
    }

    // @ts-expect-error: Not on type.
    value.sideEffects = isSideEffect(value.path);
  }

  // This pass will surface all recursive dependencies that are side-effect-ful and mark them early
  // so we aren't redoing recursive checks later.
  // e.g. `./index.js` -> `./foo.js` -> `./bar.js` -> `./baz.js` (side-effect)
  // All modules will be marked as side-effect-ful.
  for (const value of graph.dependencies.values()) {
    if (hasSideEffect(graph, value)) {
      // @ts-expect-error: Not on type.
      value.sideEffects = true;
    }
  }

  return [entryPoint, preModules, graph, options];
}
