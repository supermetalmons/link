import assert from "node:assert/strict";
import test from "node:test";
import {
  closeTopRightPopover,
  hasTopRightPopoverVisible,
  registerTopRightControlsApi,
} from "../src/ui/controls/topRightControlsPort.ts";

test("top-right controls are closed and safe to dismiss before registration", () => {
  assert.equal(hasTopRightPopoverVisible(), false);
  assert.doesNotThrow(() => closeTopRightPopover());
});

test("top-right controls forward dismissals and read live visibility", () => {
  let visible = false;
  let closeCount = 0;
  const dispose = registerTopRightControlsApi({
    close: () => {
      closeCount++;
      visible = false;
    },
    hasVisiblePopover: () => visible,
  });

  try {
    assert.equal(hasTopRightPopoverVisible(), false);
    visible = true;
    assert.equal(hasTopRightPopoverVisible(), true);
    closeTopRightPopover();
    assert.equal(closeCount, 1);
    assert.equal(hasTopRightPopoverVisible(), false);
  } finally {
    dispose();
  }
});

test("an older top-right registration cannot clear its replacement", () => {
  /** @type {string[]} */
  const calls = [];
  const disposeFirst = registerTopRightControlsApi({
    close: () => calls.push("first"),
    hasVisiblePopover: () => false,
  });
  const disposeSecond = registerTopRightControlsApi({
    close: () => calls.push("second"),
    hasVisiblePopover: () => true,
  });

  try {
    disposeFirst();
    assert.equal(hasTopRightPopoverVisible(), true);
    closeTopRightPopover();
    assert.deepEqual(calls, ["second"]);
  } finally {
    disposeFirst();
    disposeSecond();
  }
});

test("disposing the active top-right registration restores safe defaults", () => {
  let closeCount = 0;
  const dispose = registerTopRightControlsApi({
    close: () => closeCount++,
    hasVisiblePopover: () => true,
  });

  try {
    assert.equal(hasTopRightPopoverVisible(), true);
    dispose();
    dispose();
    assert.equal(hasTopRightPopoverVisible(), false);
    closeTopRightPopover();
    assert.equal(closeCount, 0);
  } finally {
    dispose();
  }
});
