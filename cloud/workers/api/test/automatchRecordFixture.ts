import {
  decodeSnapshot,
  retainAutomatchValue,
  retainAutomatchMutation,
} from "../src/automatchD1/codec.ts";
import type {
  AutomatchRoot,
  AutomatchRecordValue,
  AutomatchRecordSnapshot,
  AutomatchRecordMutation,
  AutomatchOutboxRoot,
  AutomatchOutboxRecoveryPage,
} from "../src/automatchD1/types.ts";
import type { RecoveryScanPage } from "../src/recoveryScanPage.ts";

export function automatchValueFixture<Root extends AutomatchRoot>(
  root: Root,
  value: unknown,
): AutomatchRecordValue<Root> {
  return decodeSnapshot(root, {
    record_key: "fixture",
    payload_json: value === null ? null : JSON.stringify(value),
    revision: value === null ? 0 : 1,
  }).value;
}

export function retainedAutomatchValueFixture<Root extends AutomatchRoot>(
  root: Root,
  value: unknown,
): AutomatchRecordValue<Root> {
  return retainAutomatchValue(root, value);
}

export function retainedAutomatchReadFixture<Root extends AutomatchRoot>(
  _root: Root,
  value: Promise<unknown>,
): Promise<AutomatchRecordValue<Root>> {
  return value as Promise<AutomatchRecordValue<Root>>;
}

export function retainedAutomatchRecordsFixture<Root extends AutomatchRoot>(
  _root: Root,
  value: unknown,
): Record<string, AutomatchRecordValue<Root>> | null {
  return value as Record<string, AutomatchRecordValue<Root>> | null;
}

export function retainedAutomatchPageFixture<Root extends AutomatchOutboxRoot>(
  _root: Root,
  page: RecoveryScanPage<unknown>,
): AutomatchOutboxRecoveryPage<Root> {
  return page as AutomatchOutboxRecoveryPage<Root>;
}

export function retainedAutomatchSnapshotFixture<Root extends AutomatchRoot>(
  root: Root,
  key: string,
  value: unknown,
  revision: number,
): AutomatchRecordSnapshot<Root> {
  return {
    root,
    key,
    value: retainAutomatchValue(root, value),
    revision,
  } as AutomatchRecordSnapshot<Root>;
}

export function retainedAutomatchMutationFixture(
  current: AutomatchRecordSnapshot,
  value: unknown,
): AutomatchRecordMutation {
  return retainAutomatchMutation(current, value);
}

export function retainedAutomatchClaimFixture<Root extends AutomatchOutboxRoot>(
  _root: Root,
  value: unknown,
): AutomatchRecordSnapshot<Root> {
  return value as AutomatchRecordSnapshot<Root>;
}

export function retainedAutomatchPageReaderFixture<
  Root extends AutomatchOutboxRoot,
  Arguments extends unknown[],
>(
  _root: Root,
  read: (...args: Arguments) => Promise<RecoveryScanPage<unknown>>,
): (...args: Arguments) => Promise<AutomatchOutboxRecoveryPage<Root>> {
  return read as (
    ...args: Arguments
  ) => Promise<AutomatchOutboxRecoveryPage<Root>>;
}
