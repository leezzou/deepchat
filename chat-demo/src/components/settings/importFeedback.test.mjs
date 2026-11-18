import assert from 'node:assert/strict'
import test from 'node:test'
import { backupFeatureEn, backupFeatureZh } from '../../i18n/backupFeature.ts'
import { importFailure, importPercent } from './importFeedback.ts'

test('stage progress uses measured bytes and requires a usable total', () => {
  assert.equal(importPercent(), undefined)
  for (const [processed, total] of [[1, 0], [1, -1], [5, 4], [-1, 1], [1, Infinity], [NaN, 1]]) {
    assert.equal(importPercent({ processed, total }), undefined)
  }
  assert.equal(importPercent({ processed: 0, total: 100 }), 0)
  assert.equal(importPercent({ processed: 500, total: 1000 }), 50)
  assert.equal(importPercent({ processed: 999, total: 1000 }), 99)
  assert.equal(importPercent({ processed: 1000, total: 1000 }), 100)
})

test('download failures report HTTP status and a local action without revealing signed links', () => {
  const privateUrl = 'https://fixture.invalid/export?signature=private-fixture-token'
  for (const [message, reason, action, code] of [
    [`HTTP 403 ${privateUrl}`, 'importHttpDenied', 'importRenewLink', 403],
    [`Server returned HTTP response code: 503 for URL: ${privateUrl}`, 'importHttpOther', 'importDownloadAction', 503],
    [`Unable to fetch ${privateUrl}`, 'importNetwork', 'importDownloadAction', undefined],
  ]) {
    const result = importFailure('downloading', new Error(message))
    assert.equal(result.stage, 'downloading')
    assert.equal(result.failure.reason, reason)
    assert.equal(result.failure.action, action)
    assert.equal(result.failure.params?.code, code)
    assert.doesNotMatch(JSON.stringify(result), /signature|private-fixture-token|fixture\.invalid/)
  }
})

test('failed stages retain storage, snapshot, file access and archive recovery advice', () => {
  for (const [stage, error, key, expectedStage, reason, action] of [
    ['reading', new Error(), 'importTooLarge', 'reading', 'importTooLarge', 'importChooseSmaller'],
    ['downloading', Object.assign(new Error(), { name: 'ArchiveSizeError' }), undefined, 'downloading', 'importTooLarge', 'importChooseSmaller'],
    ['reading', new DOMException('File unavailable', 'NotReadableError'), undefined, 'reading', 'importReadError', 'importReadAction'],
    ['reading', new Error(), 'backupNewerVersion', 'validating', 'importVersionError', 'importUpdateAction'],
    ['reading', new Error(), 'backupUnrecognized', 'validating', 'importFormatError', 'importArchiveAction'],
    ['validating', new Error(), 'backupInvalidJson', 'validating', 'backupInvalidJson', 'importArchiveAction'],
    ['snapshot', new Error('Copy failed', { cause: new DOMException('Disk full', 'QuotaExceededError') }), undefined, 'snapshot', 'importQuotaError', 'importSpaceAction'],
    ['snapshot', new Error('Copy failed', { cause: new Error('Current history has unsaved changes') }), undefined, 'snapshot', 'importUnsavedError', 'importWaitAction'],
    ['commit', new DOMException('Failed to write blobs.', 'UnknownError'), undefined, 'commit', 'importBlobError', 'importStorageAction'],
    ['commit', new DOMException('Transaction aborted', 'AbortError'), undefined, 'commit', 'importStorageError', 'importStorageAction'],
  ]) {
    const result = importFailure(stage, error, key)
    assert.equal(result.stage, expectedStage)
    assert.equal(result.failure.reason, reason)
    assert.equal(result.failure.action, action)
    for (const locale of [backupFeatureEn, backupFeatureZh]) {
      assert.ok(locale[action])
      if (reason !== 'backupInvalidJson') { assert.ok(locale[reason]) }
    }
  }
})
