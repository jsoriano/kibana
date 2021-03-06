/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { Registry } from '@kbn/interpreter/target/common';
import { CoreSetup } from 'src/core/public';
// The following dependencies on ui/* and src/legacy/core_plugins must be mocked when testing
import chrome, { Chrome } from 'ui/chrome';
import { npSetup, npStart } from 'ui/new_platform';
import { Storage } from '../../../../../../src/plugins/kibana_utils/public';
import { ExpressionFunction } from '../../../../../../src/legacy/core_plugins/interpreter/public';
import { functionsRegistry } from '../../../../../../src/legacy/core_plugins/interpreter/public/registries';
import { getIndexPatternDatasource } from './indexpattern';
import { renameColumns } from './rename_columns';
import { autoDate } from './auto_date';

// TODO these are intermediary types because interpreter is not typed yet
// They can get replaced by references to the real interfaces as soon as they
// are available

export interface IndexPatternDatasourceSetupPlugins {
  chrome: Chrome;
  interpreter: InterpreterSetup;
}

export interface InterpreterSetup {
  functionsRegistry: Registry<
    ExpressionFunction<string, unknown, unknown, unknown>,
    ExpressionFunction<string, unknown, unknown, unknown>
  >;
}

class IndexPatternDatasourcePlugin {
  constructor() {}

  setup(core: CoreSetup, { interpreter }: IndexPatternDatasourceSetupPlugins) {
    interpreter.functionsRegistry.register(() => renameColumns);
    interpreter.functionsRegistry.register(() => autoDate);
  }

  stop() {}
}

const plugin = new IndexPatternDatasourcePlugin();

export const indexPatternDatasourceSetup = () => {
  plugin.setup(npSetup.core, {
    chrome,
    interpreter: {
      functionsRegistry,
    },
  });

  return getIndexPatternDatasource({
    core: npStart.core,
    chrome,
    storage: new Storage(localStorage),
    savedObjectsClient: chrome.getSavedObjectsClient(),
    data: npStart.plugins.data,
  });
};
export const indexPatternDatasourceStop = () => plugin.stop();
