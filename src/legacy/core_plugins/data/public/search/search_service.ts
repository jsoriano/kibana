/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { SavedObjectsClientContract } from 'src/core/public';
import { createSavedQueryService } from './search_bar/lib/saved_query_service';

/**
 * Search Service
 * @internal
 */

export class SearchService {
  public setup() {
    // Service requires index patterns, which are only available in `start`
  }

  public start(savedObjectsClient: SavedObjectsClientContract) {
    return {
      services: {
        savedQueryService: createSavedQueryService(savedObjectsClient),
      },
    };
  }

  public stop() {}
}

/** @public */

export type SearchStart = ReturnType<SearchService['start']>;
