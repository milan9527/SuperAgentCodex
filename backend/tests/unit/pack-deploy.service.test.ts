import { describe, expect, it } from 'vitest';
import { getPackIdFromDirectory } from '../../src/services/pack-deploy.service.js';

describe('Industry Pack runtime IDs', () => {
  it('uses the directory name as the deployable Pack ID', () => {
    expect(getPackIdFromDirectory('industry-pack-voice')).toBe('voice');
    expect(getPackIdFromDirectory('industry-pack-customer-service')).toBe('customer-service');
  });

  it('rejects non-Pack and empty directory names', () => {
    expect(getPackIdFromDirectory('voice')).toBeNull();
    expect(getPackIdFromDirectory('industry-pack-')).toBeNull();
  });
});
