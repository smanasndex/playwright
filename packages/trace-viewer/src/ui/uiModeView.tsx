/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import '@web/third_party/vscode/codicon.css';
import '@web/common.css';
import React from 'react';
import { TeleSuite } from '@testIsomorphic/teleReceiver';
import { TeleSuiteUpdater } from './teleSuiteUpdater';
import type { Progress } from './uiModeModel';
import type { TeleTestCase } from '@testIsomorphic/teleReceiver';
import type * as reporterTypes from 'playwright/types/testReporter';
import { SplitView } from '@web/components/splitView';
import type { SourceLocation } from './modelUtil';
import './uiModeView.css';
import { ToolbarButton } from '@web/components/toolbarButton';
import { Toolbar } from '@web/components/toolbar';
import type { XtermDataSource } from '@web/components/xtermWrapper';
import { XtermWrapper } from '@web/components/xtermWrapper';
import { toggleTheme } from '@web/theme';
import { settings, useSetting } from '@web/uiUtils';
import { statusEx, TestTree } from '@testIsomorphic/testTree';
import type { TreeItem  } from '@testIsomorphic/testTree';
import { TestServerConnection } from '@testIsomorphic/testServerConnection';
import { pathSeparator } from './uiModeModel';
import type { TestModel } from './uiModeModel';
import { FiltersView } from './uiModeFiltersView';
import { TestListView } from './uiModeTestListView';
import { TraceView } from './uiModeTraceView';

let xtermSize = { cols: 80, rows: 24 };
const xtermDataSource: XtermDataSource = {
  pending: [],
  clear: () => {},
  write: data => xtermDataSource.pending.push(data),
  resize: () => {},
};

export const UIModeView: React.FC<{}> = ({
}) => {
  const [filterText, setFilterText] = React.useState<string>('');
  const [isShowingOutput, setIsShowingOutput] = React.useState<boolean>(false);
  const [statusFilters, setStatusFilters] = React.useState<Map<string, boolean>>(new Map([
    ['passed', false],
    ['failed', false],
    ['skipped', false],
  ]));
  const [projectFilters, setProjectFilters] = React.useState<Map<string, boolean>>(new Map());
  const [testModel, setTestModel] = React.useState<TestModel>();
  const [progress, setProgress] = React.useState<Progress & { total: number } | undefined>();
  const [selectedItem, setSelectedItem] = React.useState<{ treeItem?: TreeItem, testFile?: SourceLocation, testCase?: reporterTypes.TestCase }>({});
  const [visibleTestIds, setVisibleTestIds] = React.useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = React.useState<boolean>(false);
  const [runningState, setRunningState] = React.useState<{ testIds: Set<string>, itemSelectedByUser?: boolean } | undefined>();
  const [watchAll, setWatchAll] = useSetting<boolean>('watch-all', false);
  const [watchedTreeIds, setWatchedTreeIds] = React.useState<{ value: Set<string> }>({ value: new Set() });
  const commandQueue = React.useRef(Promise.resolve());
  const runTestBacklog = React.useRef<Set<string>>(new Set());
  const [collapseAllCount, setCollapseAllCount] = React.useState(0);
  const [isDisconnected, setIsDisconnected] = React.useState(false);
  const [hasBrowsers, setHasBrowsers] = React.useState(true);
  const [testServerConnection, setTestServerConnection] = React.useState<TestServerConnection>();

  const inputRef = React.useRef<HTMLInputElement>(null);

  const reloadTests = React.useCallback(() => {
    const guid = new URLSearchParams(window.location.search).get('ws');
    const wsURL = new URL(`../${guid}`, window.location.toString());
    wsURL.protocol = (window.location.protocol === 'https:' ? 'wss:' : 'ws:');
    setTestServerConnection(new TestServerConnection(wsURL.toString()));
  }, []);

  // Load tests on startup.
  React.useEffect(() => {
    inputRef.current?.focus();
    setIsLoading(true);
    reloadTests();
  }, [reloadTests]);

  // Wire server connection to the auxiliary UI features.
  React.useEffect(() => {
    if (!testServerConnection)
      return;
    const disposables = [
      testServerConnection.onStdio(params => {
        if (params.buffer) {
          const data = atob(params.buffer);
          xtermDataSource.write(data);
        } else {
          xtermDataSource.write(params.text!);
        }
      }),
      testServerConnection.onClose(() => setIsDisconnected(true))
    ];
    xtermDataSource.resize = (cols, rows) => {
      xtermSize = { cols, rows };
      testServerConnection.resizeTerminalNoReply({ cols, rows });
    };
    return () => {
      for (const disposable of disposables)
        disposable.dispose();
    };
  }, [testServerConnection]);

  // This is the main routine, every time connection updates it starts the
  // whole workflow.
  React.useEffect(() => {
    if (!testServerConnection)
      return;

    let throttleTimer: NodeJS.Timeout | undefined;
    const teleSuiteUpdater = new TeleSuiteUpdater({
      onUpdate: immediate => {
        clearTimeout(throttleTimer);
        throttleTimer = undefined;
        if (immediate) {
          setTestModel(teleSuiteUpdater.asModel());
        } else if (!throttleTimer) {
          throttleTimer = setTimeout(() => {
            setTestModel(teleSuiteUpdater.asModel());
          }, 250);
        }
      },
      onError: error => {
        xtermDataSource.write((error.stack || error.value || '') + '\n');
      },
      pathSeparator,
    });

    const updateList = async () => {
      commandQueue.current = commandQueue.current.then(async () => {
        setIsLoading(true);
        try {
          const result = await testServerConnection.listTests({});
          teleSuiteUpdater.processListReport(result.report);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.log(e);
        } finally {
          setIsLoading(false);
        }
      });
    };

    setTestModel(undefined);
    setIsLoading(true);
    setWatchedTreeIds({ value: new Set() });
    (async () => {
      const status = await testServerConnection.runGlobalSetup();
      if (status !== 'passed')
        return;
      const result = await testServerConnection.listTests({});
      teleSuiteUpdater.processListReport(result.report);

      testServerConnection.onListChanged(updateList);
      testServerConnection.onReport(params => {
        teleSuiteUpdater.processTestReportEvent(params);
      });
      setIsLoading(false);

      const { hasBrowsers } = await testServerConnection.checkBrowsers();
      setHasBrowsers(hasBrowsers);
    })();
    return () => {
      clearTimeout(throttleTimer);
    };
  }, [testServerConnection]);

  // Update project filter default values.
  React.useEffect(() => {
    if (!testModel)
      return;

    const { config, rootSuite } = testModel;
    const selectedProjects = config.configFile ? settings.getObject<string[] | undefined>(config.configFile + ':projects', undefined) : undefined;
    const newFilter = new Map(projectFilters);
    for (const projectName of newFilter.keys()) {
      if (!rootSuite.suites.find(s => s.title === projectName))
        newFilter.delete(projectName);
    }
    for (const projectSuite of rootSuite.suites) {
      if (!newFilter.has(projectSuite.title))
        newFilter.set(projectSuite.title, !!selectedProjects?.includes(projectSuite.title));
    }
    if (!selectedProjects && newFilter.size && ![...newFilter.values()].includes(true))
      newFilter.set(newFilter.entries().next().value[0], true);
    if (projectFilters.size !== newFilter.size || [...projectFilters].some(([k, v]) => newFilter.get(k) !== v))
      setProjectFilters(newFilter);
  }, [projectFilters, testModel]);

  // Update progress.
  React.useEffect(() => {
    if (runningState && testModel?.progress)
      setProgress(testModel.progress);
    else if (!testModel)
      setProgress(undefined);
  }, [testModel, runningState]);

  // Test tree is built from the model and filters.
  const { testTree } = React.useMemo(() => {
    if (!testModel)
      return { testTree: new TestTree('', new TeleSuite('', 'root'), [], projectFilters, pathSeparator) };
    const testTree = new TestTree('', testModel.rootSuite, testModel.loadErrors, projectFilters, pathSeparator);
    testTree.filterTree(filterText, statusFilters, runningState?.testIds);
    testTree.sortAndPropagateStatus();
    testTree.shortenRoot();
    testTree.flattenForSingleProject();
    setVisibleTestIds(testTree.testIds());
    return { testTree };
  }, [filterText, testModel, statusFilters, projectFilters, setVisibleTestIds, runningState]);

  const runTests = React.useCallback((mode: 'queue-if-busy' | 'bounce-if-busy', testIds: Set<string>) => {
    if (!testServerConnection || !testModel)
      return;
    if (mode === 'bounce-if-busy' && runningState)
      return;

    runTestBacklog.current = new Set([...runTestBacklog.current, ...testIds]);
    commandQueue.current = commandQueue.current.then(async () => {
      const testIds = runTestBacklog.current;
      runTestBacklog.current = new Set();
      if (!testIds.size)
        return;

      // Clear test results.
      {
        for (const test of testModel.rootSuite?.allTests() || []) {
          if (testIds.has(test.id)) {
            (test as TeleTestCase)._clearResults();
            const result = (test as TeleTestCase)._createTestResult('pending');
            (result as any)[statusEx] = 'scheduled';
          }
        }
        setTestModel({ ...testModel });
      }

      const time = '  [' + new Date().toLocaleTimeString() + ']';
      xtermDataSource.write('\x1B[2m—'.repeat(Math.max(0, xtermSize.cols - time.length)) + time + '\x1B[22m');
      setProgress({ total: 0, passed: 0, failed: 0, skipped: 0 });
      setRunningState({ testIds });

      await testServerConnection.runTests({ testIds: [...testIds], projects: [...projectFilters].filter(([_, v]) => v).map(([p]) => p) });
      // Clear pending tests in case of interrupt.
      for (const test of testModel.rootSuite?.allTests() || []) {
        if (test.results[0]?.duration === -1)
          (test as TeleTestCase)._clearResults();
      }
      setTestModel({ ...testModel });
      setRunningState(undefined);
    });
  }, [projectFilters, runningState, testModel, testServerConnection]);

  // Watch implementation.
  React.useEffect(() => {
    if (!testServerConnection)
      return;
    const disposable = testServerConnection.onTestFilesChanged(params => {
      const testIds: string[] = [];
      const set = new Set(params.testFiles);
      if (watchAll) {
        const visit = (treeItem: TreeItem) => {
          const fileName = treeItem.location.file;
          if (fileName && set.has(fileName))
            testIds.push(...testTree.collectTestIds(treeItem));
          if (treeItem.kind === 'group' && treeItem.subKind === 'folder')
            treeItem.children.forEach(visit);
        };
        visit(testTree.rootItem);
      } else {
        for (const treeId of watchedTreeIds.value) {
          const treeItem = testTree.treeItemById(treeId);
          const fileName = treeItem?.location.file;
          if (fileName && set.has(fileName))
            testIds.push(...testTree.collectTestIds(treeItem));
        }
      }
      runTests('queue-if-busy', new Set(testIds));
    });
    return () => disposable.dispose();
  }, [runTests, testServerConnection, testTree, watchAll, watchedTreeIds]);

  // Shortcuts.
  React.useEffect(() => {
    if (!testServerConnection)
      return;
    const onShortcutEvent = (e: KeyboardEvent) => {
      if (e.code === 'F6') {
        e.preventDefault();
        testServerConnection?.stopTestsNoReply();
      } else if (e.code === 'F5') {
        e.preventDefault();
        reloadTests();
      }
    };
    addEventListener('keydown', onShortcutEvent);
    return () => {
      removeEventListener('keydown', onShortcutEvent);
    };
  }, [runTests, reloadTests, testServerConnection]);

  const isRunningTest = !!runningState;
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const openInstallDialog = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dialogRef.current?.showModal();
  }, []);
  const closeInstallDialog = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dialogRef.current?.close();
  }, []);
  const installBrowsers = React.useCallback((e: React.MouseEvent) => {
    closeInstallDialog(e);
    setIsShowingOutput(true);
    testServerConnection?.installBrowsers().then(async () => {
      setIsShowingOutput(false);
      const { hasBrowsers } = await testServerConnection?.checkBrowsers();
      setHasBrowsers(hasBrowsers);
    });
  }, [closeInstallDialog, testServerConnection]);

  return <div className='vbox ui-mode'>
    {!hasBrowsers && <dialog ref={dialogRef}>
      <div className='title'><span className='codicon codicon-lightbulb'></span>Install browsers</div>
      <div className='body'>
        Playwright did not find installed browsers.
        <br></br>
        Would you like to run `playwright install`?
        <br></br>
        <button className='button' onClick={installBrowsers}>Install</button>
        <button className='button secondary' onClick={closeInstallDialog}>Dismiss</button>
      </div>
    </dialog>}
    {isDisconnected && <div className='disconnected'>
      <div className='title'>UI Mode disconnected</div>
      <div><a href='#' onClick={() => window.location.href = '/'}>Reload the page</a> to reconnect</div>
    </div>}
    <SplitView sidebarSize={250} minSidebarSize={150} orientation='horizontal' sidebarIsFirst={true} settingName='testListSidebar'>
      <div className='vbox'>
        <div className={'vbox' + (isShowingOutput ? '' : ' hidden')}>
          <Toolbar>
            <div className='section-title' style={{ flex: 'none' }}>Output</div>
            <ToolbarButton icon='circle-slash' title='Clear output' onClick={() => xtermDataSource.clear()}></ToolbarButton>
            <div className='spacer'></div>
            <ToolbarButton icon='close' title='Close' onClick={() => setIsShowingOutput(false)}></ToolbarButton>
          </Toolbar>
          <XtermWrapper source={xtermDataSource}></XtermWrapper>
        </div>
        <div className={'vbox' + (isShowingOutput ? ' hidden' : '')}>
          <TraceView item={selectedItem} rootDir={testModel?.config?.rootDir} />
        </div>
      </div>
      <div className='vbox ui-mode-sidebar'>
        <Toolbar noShadow={true} noMinHeight={true}>
          <img src='playwright-logo.svg' alt='Playwright logo' />
          <div className='section-title'>Playwright</div>
          <ToolbarButton icon='color-mode' title='Toggle color mode' onClick={() => toggleTheme()} />
          <ToolbarButton icon='refresh' title='Reload' onClick={() => reloadTests()} disabled={isRunningTest || isLoading}></ToolbarButton>
          <ToolbarButton icon='terminal' title='Toggle output' toggled={isShowingOutput} onClick={() => { setIsShowingOutput(!isShowingOutput); }} />
          {!hasBrowsers && <ToolbarButton icon='lightbulb-autofix' style={{ color: 'var(--vscode-list-warningForeground)' }} title='Playwright browsers are missing' onClick={openInstallDialog} />}
        </Toolbar>
        <FiltersView
          filterText={filterText}
          setFilterText={setFilterText}
          statusFilters={statusFilters}
          setStatusFilters={setStatusFilters}
          projectFilters={projectFilters}
          setProjectFilters={setProjectFilters}
          testModel={testModel}
          runTests={() => runTests('bounce-if-busy', visibleTestIds)} />
        <Toolbar noMinHeight={true}>
          {!isRunningTest && !progress && <div className='section-title'>Tests</div>}
          {!isRunningTest && progress && <div data-testid='status-line' className='status-line'>
            <div>{progress.passed}/{progress.total} passed ({(progress.passed / progress.total) * 100 | 0}%)</div>
          </div>}
          {isRunningTest && progress && <div data-testid='status-line' className='status-line'>
            <div>Running {progress.passed}/{runningState.testIds.size} passed ({(progress.passed / runningState.testIds.size) * 100 | 0}%)</div>
          </div>}
          <ToolbarButton icon='play' title='Run all' onClick={() => runTests('bounce-if-busy', visibleTestIds)} disabled={isRunningTest || isLoading}></ToolbarButton>
          <ToolbarButton icon='debug-stop' title='Stop' onClick={() => testServerConnection?.stopTests()} disabled={!isRunningTest || isLoading}></ToolbarButton>
          <ToolbarButton icon='eye' title='Watch all' toggled={watchAll} onClick={() => {
            setWatchedTreeIds({ value: new Set() });
            setWatchAll(!watchAll);
          }}></ToolbarButton>
          <ToolbarButton icon='collapse-all' title='Collapse all' onClick={() => {
            setCollapseAllCount(collapseAllCount + 1);
          }} />
        </Toolbar>
        <TestListView
          filterText={filterText}
          testModel={testModel}
          testTree={testTree}
          testServerConnection={testServerConnection}
          runningState={runningState}
          runTests={runTests}
          onItemSelected={setSelectedItem}
          watchAll={watchAll}
          watchedTreeIds={watchedTreeIds}
          setWatchedTreeIds={setWatchedTreeIds}
          isLoading={isLoading}
          requestedCollapseAllCount={collapseAllCount} />
      </div>
    </SplitView>
  </div>;
};
