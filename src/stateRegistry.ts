/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { test, TestItem, TestRunState, TestState } from 'vscode';

/**
 * Utility class used in the state registry.
 */
class StateValue {
  private readonly listeners = new Set<(v: TestState) => void>();

  public get value() {
    return this._value;
  }

  public set value(value: TestState) {
    this._value = value;
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  public addListener(l: (v: TestState) => void) {
    this.listeners.add(l);
    return this.listeners.size;
  }

  public removeListener(l: (v: TestState) => void) {
    this.listeners.delete(l);
    return this.listeners.size;
  }

  constructor(private _value: TestState) {}
}

const getItemInResults = (id: string) => {
  const find = (result: TestItem): TestItem | undefined =>
    result.id === id ? result : result.children?.find(find);

  for (const t of test.testResults?.tests ?? []) {
    const found = find(t);
    if (found) {
      return found;
    }
  }

  return undefined;
};

/**
 * Singleton used to share state internally between tests in text files and
 * those in the workspace.
 */
class StateRegistry {
  public static unsetState = new TestState(TestRunState.Unset);

  private readonly values = new Map<string, StateValue>();

  public current(id: string) {
    return this.values.get(id)?.value ?? getItemInResults(id)?.state ?? StateRegistry.unsetState;
  }

  public update(id: string, value: TestState) {
    const record = this.values.get(id);
    if (record && record.value !== value) {
      record.value = value;
    }
  }

  public listen(id: string, l: (v: TestState) => void) {
    let value = this.values.get(id);
    if (!value) {
      value = new StateValue(this.current(id));
      this.values.set(id, value);
    }

    value.addListener(l);
    return () => {
      if (value!.removeListener(l) === 0) {
        this.values.delete(id);
      }
    };
  }
}

export const states = new StateRegistry();
