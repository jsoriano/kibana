/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { i18n } from '@kbn/i18n';

export const ANOMALY_DETECTION = i18n.translate(
  'xpack.siem.components.mlPopup.anomalyDetectionButtonLabel',
  {
    defaultMessage: 'Anomaly detection',
  }
);

export const ANOMALY_DETECTION_TITLE = i18n.translate(
  'xpack.siem.components.mlPopup.anomalyDetectionTitle',
  {
    defaultMessage: 'Anomaly detection settings',
  }
);

export const UPGRADE_TITLE = i18n.translate('xpack.siem.components.mlPopup.upgradeTitle', {
  defaultMessage: 'Upgrade to Elastic Platinum',
});

export const UPGRADE_BUTTON = i18n.translate('xpack.siem.components.mlPopup.upgradeButtonLabel', {
  defaultMessage: 'Subscription plans',
});

export const LICENSE_BUTTON = i18n.translate('xpack.siem.components.mlPopup.licenseButtonLabel', {
  defaultMessage: 'Manage license',
});

export const MODULE_NOT_COMPATIBLE_TITLE = (incompatibleJobCount: number) =>
  i18n.translate('xpack.siem.components.mlPopup.moduleNotCompatibleTitle', {
    values: { incompatibleJobCount },
    defaultMessage:
      '{incompatibleJobCount} {incompatibleJobCount, plural, =1 {job} other {jobs}} are currently unavailable',
  });

export const MODULE_NOT_COMPATIBLE_DESCRIPTION = i18n.translate(
  'xpack.siem.components.mlPopup.moduleNotCompatibleDescription',
  {
    defaultMessage:
      'You may be missing the required index patterns. Learn more in our documentation.',
  }
);

export const START_JOB_FAILURE = i18n.translate(
  'xpack.siem.components.mlPopup.errors.startJobFailureTitle',
  {
    defaultMessage: 'Start job failure',
  }
);

export const STOP_JOB_FAILURE = i18n.translate('xpack.siem.containers.errors.stopJobFailureTitle', {
  defaultMessage: 'Stop job failure',
});

export const CREATE_JOB_FAILURE = i18n.translate(
  'xpack.siem.components.mlPopup.errors.createJobFailureTitle',
  {
    defaultMessage: 'Create job failure',
  }
);
