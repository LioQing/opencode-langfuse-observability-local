import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../dist/app.js';

const directory = await mkdtemp(join(tmpdir(), 'observatory-ui-'));
const p = 'langfuse.observation.';
const filename = '2026-09-27-15-59-36-ses_browser.jsonl';
const records = [
  { [p + 'type']: 'event', [p + 'input']: [{ role: 'user', content: 'Search for a test result' }], startTimeUnixNano: '1790495971615000000' },
  { [p + 'type']: 'tool', [p + 'metadata']: { callID: 'call_browser', tool: 'websearch' }, [p + 'input']: { query: 'test' }, [p + 'output']: { output: 'Matched tool result' }, startTimeUnixNano: '1790496018942000000' },
  { [p + 'type']: 'generation', [p + 'model.name']: 'test-model', [p + 'metadata']: { providerID: 'test-provider', variant: 'medium', mode: 'build' }, [p + 'input']: { system: ['private system history'], messages: [{ role: 'user', content: 'Search' }] }, [p + 'output']: [{ role: 'assistant', thinking: [{ type: 'thinking', content: 'Looking it up' }], tool_calls: [{ id: 'call_browser', name: 'websearch', arguments: '{"query":"test"}' }] }], [p + 'usage_details']: { input: 100, output: 20, reasoning: 10, cache_read: 900, cache_write: 10, total: 130 }, [p + 'cost_details']: { total: 0 }, startTimeUnixNano: '1790496016931000000', endTimeUnixNano: '1790496018931000000' },
  { [p + 'type']: 'generation', [p + 'input']: { messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }] }, [p + 'output']: [{ role: 'assistant', content: '**Final answer**\n\n<script>window.untrustedExecuted=true</script>\n\n[Unsafe](javascript:alert(1))' }], [p + 'usage_details']: { input: 50, output: 30, reasoning: 0, cache_read: 950, cache_write: 0, total: 80 }, [p + 'cost_details']: { total: 0 }, startTimeUnixNano: '1790496026931000000', endTimeUnixNano: '1790496029931000000' },
];
const serialize = values => values.map(value => JSON.stringify(value)).join('\n') + '\n';
let browser;
const pricing = { catalog: { 'test-provider': { models: { 'test-model': { cost: { input: 1, output: 2, reasoning: 3, cache_read: 0.1, cache_write: 0.5 } } } } } };
const app = createApp(() => {}, directory, undefined, 30, pricing);
try {
  await writeFile(join(directory, filename), serialize(records));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  const historyRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('&item=')) historyRequests.push(request.url()); });
  await page.goto(`${address}/dashboard`);
  await expect(page.locator('.session-link')).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Search sessions' }).fill('absent');
  await expect(page.getByText('No matching sessions')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.locator('.session-link h3')).toHaveText('Search for a test result');
  await expect(page.locator('.metrics .cost-estimate')).toContainText('Estimated $0.00047');
  await page.locator('.session-link').click();
  await expect(page.locator('h1')).toHaveText('Search for a test result');
  await expect(page.locator('.session-filename')).toHaveText(filename);
  await expect(page).toHaveTitle('Search for a test result · Observatory');
  const durationMetric = page.locator('.session-metrics .metric').filter({ hasText: 'Total duration' });
  await expect(durationMetric.locator('strong')).toHaveText('55s');
  await expect(durationMetric.locator('.metric-bottom')).toContainText('Generation time 5s · 9.0%');
  const speedMetric = page.locator('.session-metrics .metric').filter({ hasText: 'Effective token speed' });
  await expect(speedMetric.locator('strong')).toContainText('1.3');
  await expect(speedMetric.locator('strong small')).toHaveText('tokens/s');
  await expect(speedMetric.locator('.metric-bottom')).toContainText('Actual · 14.0 tokens/s');
  await expect(speedMetric.locator('.metric-bottom')).toContainText('Output + reasoning + cached output');
  await expect(page.locator('.session-metrics .cost-estimate')).toContainText('Estimated $0.00047');
  await expect(page.locator('.session-metrics .cost-estimate')).toContainText('$0.00015 in');
  await expect(page.locator('.session-metrics .cost-estimate')).toContainText('$0.00013 out');
  await expect(page.locator('.session-metrics .cost-estimate')).toContainText('$0.000185 cached in');
  await expect(page.locator('.session-metrics .cost-estimate')).toContainText('$0.000005 cached out');
  const composition = page.locator('.mix-panel .usage-table');
  await expect(composition.locator('.usage-row.table-head')).toContainText('% of total $');
  await expect(composition.locator('.usage-row.total-row')).toContainText('$0.00047');
  await expect(composition.locator('.usage-bar-label')).toHaveText(['Tokens', 'Estimated cost · USD']);
  await expect(composition.getByRole('group', { name: 'Estimated cost composition by category' }).locator('.usage-segment')).toHaveCount(5);
  const chart = page.locator('.volume-panel .bar-chart');
  assert.equal(await chart.evaluate(node => node.getBoundingClientRect().height > 250), true);
  assert.deepEqual(await chart.locator('.chart-column').evaluateAll(columns => columns.map(column =>
    [...column.querySelectorAll('.chart-column-icons .type-icon')].map(icon => [...icon.classList].at(-1)))), [['generation', 'tool'], ['response']]);
  // Exercise a crowded chart without changing the session fixture or its navigation targets.
  await chart.evaluate(node => {
    const originals = [...node.querySelectorAll('.chart-column')];
    for (let i = originals.length; i < 18; i++) {
      const copy = originals[i % originals.length].cloneNode(true);
      copy.classList.add('layout-test-column');
      node.append(copy);
    }
  });
  const assertChartLayout = async () => assert.deepEqual(await chart.evaluate(node => {
    const plot = node.getBoundingClientRect();
    return {
      verticalOverflow: node.scrollHeight > node.clientHeight + 1,
      paintedIconRow: getComputedStyle(node.querySelector('.chart-column-icons')).backgroundColor !== 'rgba(0, 0, 0, 0)',
      clippedColumn: [...node.querySelectorAll('.chart-column')].some(column => column.getBoundingClientRect().bottom > plot.bottom + 1),
      clippedBar: [...node.querySelectorAll('.chart-column-bar > span')].some(bar => {
        const rect = bar.getBoundingClientRect();
        const track = bar.parentElement.getBoundingClientRect();
        return rect.top < track.top - 1 || rect.bottom > track.bottom + 1;
      }),
    };
  }), { verticalOverflow: false, paintedIconRow: false, clippedColumn: false, clippedBar: false });
  await assertChartLayout();
  assert.equal(await chart.evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await assertChartLayout();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await chart.locator('.layout-test-column').evaluateAll(columns => columns.forEach(column => column.remove()));
  const generation = page.locator('#observation-4');
  await expect(generation.getByText('Recorded cost · USD')).toBeVisible();
  await expect(generation.locator('.execution').getByText('Estimated cost · USD')).toBeVisible();
  await expect(generation.locator('.execution')).toContainText('$0.000205');
  const modelPrice = generation.getByRole('region', { name: 'Model price' });
  await expect(modelPrice).toContainText('USD / 1M tokens');
  await expect(modelPrice.locator('.model-price-grid>div')).toHaveText(['Input$1.00', 'Output$2.00', 'Cached input$0.10', 'Cached output$0.50']);
  assert.equal(await modelPrice.locator('.model-price-grid>div').evaluateAll(nodes => new Set(nodes.map(node => node.getBoundingClientRect().top)).size), 1);
  await expect(modelPrice.getByRole('link', { name: 'models.dev' })).toHaveAttribute('href', 'https://models.dev/');
  await expect(generation.getByText('Cost breakdown')).toHaveCount(0);
  assert.equal(await generation.locator('.model-price').evaluate(node => node.compareDocumentPosition(node.parentElement.querySelector('.usage-table')) & Node.DOCUMENT_POSITION_FOLLOWING ? true : false), true);
  await expect(generation.getByRole('heading', { name: 'Token usage & cost' })).toBeVisible();
  await expect(generation.locator('.usage-row.table-head')).toContainText('Estimated $');
  await expect(generation.locator('.usage-row.table-head')).toContainText('% of total $');
  await expect(generation.locator('.usage-row').filter({ hasText: 'Output' }).first()).toContainText('$0.00006');
  await expect(generation.locator('.usage-row').filter({ hasText: 'Cached input' })).toContainText('$0.000095');
  await expect(generation.locator('.usage-row.total-row')).toContainText('$0.000205');
  await expect(generation.locator('.usage-bar-label')).toHaveText(['Tokens', 'Estimated cost · USD']);
  await expect(generation.getByRole('group', { name: 'Estimated cost composition by category' }).locator('.usage-segment')).toHaveCount(3);
  await generation.getByRole('button', { name: /Cached input: \$0\.000095/ }).hover();
  await expect(generation.getByRole('tooltip')).toContainText('46.3% of estimated cost');
  for (const table of [composition, generation.locator('.usage-table')]) {
    assert.equal(await table.locator('.usage-rows').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await table.locator('.usage-bar-wrap').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await expect(table.locator('.usage-row.table-head span').last()).toHaveText('% of total $');
    assert.equal(await table.locator('.usage-row.total-row span').nth(2).evaluate(node => getComputedStyle(node).fontWeight), '400');
  }
  await expect(page.locator('.observation')).toHaveCount(3);
  assert.deepEqual(await page.locator('.observation').evaluateAll(nodes => nodes.map(node => node.id)), ['observation-4', 'observation-3', 'observation-1']);
  await expect(page.locator('#observation-4 .type-icons .type-icon.response')).toHaveCount(1);
  await expect(page.locator('#observation-4 .type-icons .type-icon.generation')).toHaveCount(0);
  assert.deepEqual(await page.locator('#observation-3 .type-icons .type-icon').evaluateAll(nodes => nodes.map(node => [...node.classList].at(-1))), ['generation', 'tool']);
  await expect(page.locator('.is-open')).toHaveCount(1);
  await expect(page.locator('.is-open')).toHaveAttribute('id', 'observation-4');
  assert.equal(await page.locator('.observation').first().getAttribute('id'), await page.locator('.is-open').getAttribute('id'));
  const topBorders = () => page.locator('.observation').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).borderTopWidth));
  assert.deepEqual(await topBorders(), ['1px', '1px', '0px']);
  await expect(page.locator('.raw-history[open]')).toHaveCount(0);
  assert.equal(historyRequests.length, 0);
  await expect(page.locator('.is-open .prose strong')).toHaveText('Final answer');
  assert.equal(await page.evaluate(() => window.untrustedExecuted), undefined);
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  const answer = page.locator('#observation-4 .output .text-content');
  await answer.getByRole('button', { name: 'Raw' }).click();
  await expect(answer.locator('pre code')).toContainText('**Final answer**');
  await expect(answer.locator('pre code')).toContainText('<script>window.untrustedExecuted=true</script>');
  await expect(answer.locator('.prose')).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.untrustedExecuted), undefined);
  await answer.getByRole('button', { name: 'Markdown' }).click();
  await expect(answer.locator('.prose strong')).toHaveText('Final answer');

  await page.locator('#observation-3 .observation-summary').click();
  assert.deepEqual(await topBorders(), ['1px', '1px', '1px']);
  await expect(page.locator('#observation-3 .tool-results')).toContainText('Matched tool result');
  const toolText = page.locator('#observation-3 .tool-result .text-content');
  await toolText.getByRole('button', { name: 'Raw' }).click();
  await expect(toolText.locator('pre code')).toHaveText('Matched tool result');
  await expect(answer.getByRole('button', { name: 'Markdown' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#observation-3')).toContainText('89.1%');
  await expect(page.locator('#observation-3 .usage-row').filter({ hasText: 'Reasoning' })).toContainText('$0.00003');
  await expect(page.locator('#observation-3 .usage-row').filter({ hasText: 'Output' }).first()).toContainText('$0.00004');
  await page.locator('#observation-3 .raw-history summary').click();
  await expect(page.locator('#observation-3 .raw-history pre')).toContainText('private system history');
  assert.equal(historyRequests.length, 1);
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
  await expect(page.locator('.is-open')).toHaveCount(0);
  assert.deepEqual(await topBorders(), ['1px', '0px', '0px']);
  await page.locator('.chart-column').first().click();
  await expect(page.locator('#observation-3')).toHaveClass(/is-open/);
  await page.getByRole('button', { name: 'User', exact: true }).click();
  await expect(page.locator('.observation')).toHaveCount(1);
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await expect(page.locator('.observation')).toHaveCount(3);
  await expect(page.locator('#observation-4')).toHaveClass(/is-open/);

  records.push({ [p + 'type']: 'event', [p + 'input']: [{ role: 'user', content: 'New live message' }], startTimeUnixNano: '1790496036931000000' });
  await writeFile(join(directory, filename), serialize(records));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.observation')).toHaveCount(4);
  assert.deepEqual(await page.locator('.observation').evaluateAll(nodes => nodes.map(node => node.id)), ['observation-5', 'observation-4', 'observation-3', 'observation-1']);
  await expect(page.locator('.is-open')).toHaveCount(1);
  await expect(page.locator('#observation-5')).toHaveClass(/is-open/);
  await page.getByRole('textbox', { name: 'Search observations' }).fill('no match');
  await expect(page.getByRole('heading', { name: 'No observations found' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  assert.equal(await modelPrice.locator('.model-price-grid>div').evaluateAll(nodes => new Set(nodes.map(node => node.getBoundingClientRect().top)).size), 2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const assertGenerationFits = async () => {
    assert.deepEqual(await page.locator('#observation-4').evaluate(card => {
      const body = card.querySelector('.observation-body').getBoundingClientRect();
      return ['.generation-grid', '.count-grid', '.execution', '.model-price', '.model-price-grid', '.usage-table', '.usage-bar-wrap'].filter(selector =>
        [...card.querySelectorAll(selector)].some(node => node.getBoundingClientRect().right > body.right + 1 || node.getBoundingClientRect().left < body.left - 1));
    }), []);
    assert.equal(await page.locator('#observation-4 .count-grid').first().evaluate(node =>
      [...node.children].every(child => child.getBoundingClientRect().right <= node.getBoundingClientRect().right + 1)), true);
    assert.equal(await page.locator('#observation-4 .execution').evaluate(node =>
      [...node.children].every(child => child.getBoundingClientRect().right <= node.getBoundingClientRect().right + 1)), true);
  };
  await assertGenerationFits();
  for (const table of [composition, generation.locator('.usage-table')]) {
    assert.equal(await table.locator('.usage-bar-wrap').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await table.locator('.usage-bar').last().evaluate(node => node.getBoundingClientRect().width <= node.parentElement.getBoundingClientRect().width), true);
  }
  await page.setViewportSize({ width: 320, height: 720 });
  await assertGenerationFits();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.is-open')).toHaveCount(4);
  const longTitle = 'A long first request that needs to be shortened in the session heading '.repeat(3).trim();
  records[0][p + 'input'][0].content = longTitle;
  await writeFile(join(directory, filename), serialize(records));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.session-title')).toHaveText(longTitle);
  await expect(page.locator('.session-title')).toHaveAttribute('title', longTitle);
  assert.equal(await page.locator('.session-title').evaluate(node => node.scrollHeight > node.clientHeight), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator('.floating-actions')).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 800));
  const shortcuts = page.getByRole('navigation', { name: 'Session shortcuts' });
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts.getByRole('link', { name: 'All sessions' })).toHaveAttribute('href', '/dashboard');
  await shortcuts.getByRole('checkbox', { name: 'Auto-refresh' }).check();
  await expect(page.locator('.workspace-toolbar').getByRole('checkbox', { name: 'Auto-refresh' })).toBeChecked();
  const model = pricing.catalog['test-provider'].models['test-model'];
  delete model.cost;
  await page.reload();
  await page.locator('#observation-4 .observation-summary').click();
  await expect(page.locator('#observation-4 .execution')).toContainText('Estimated cost · USD—');
  await expect(page.locator('#observation-4 .usage-row.total-row')).toContainText('—');
  await expect(page.locator('#observation-4 .usage-bar-note')).toHaveText('Pricing unavailable');
  await expect(page.locator('#observation-4 .model-price-grid strong')).toHaveText(['—', '—', '—', '—']);
  await expect(composition.locator('.usage-bar-note')).toHaveText('Pricing unavailable');
  model.cost = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
  await page.reload();
  await page.locator('#observation-4 .observation-summary').click();
  await expect(page.locator('.workspace-toolbar').getByRole('checkbox', { name: 'Auto-refresh' })).toBeChecked();
  await expect(page.locator('.session-metrics .cost-estimate')).toHaveCount(0);
  await expect(page.locator('.session-metrics .metric').filter({ hasText: 'Recorded cost' }).locator('.metric-bottom')).toHaveText('Across all generations');
  await expect(page.locator('#observation-4 .usage-row.total-row')).toContainText('$0.00');
  await expect(page.locator('#observation-4 .usage-bar-note')).toHaveCount(0);
  await expect(page.locator('#observation-4 .model-price-grid strong')).toHaveText(['$0.00', '$0.00', '$0.00', '$0.00']);
  await expect(composition.locator('.usage-bar-note')).toHaveCount(0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.locator('.floating-actions')).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 800));
  await expect(shortcuts).toBeVisible();
  await shortcuts.getByRole('button', { name: 'Back to top' }).click();
  await expect(page.locator('.floating-actions')).toBeHidden();
  assert.equal(await page.evaluate(() => scrollY), 0);
  await page.goto(`${address}/dashboard?session=missing.jsonl`);
  await expect(page.getByRole('alert')).toContainText('Session not found');
  await page.getByRole('link', { name: 'Back to library' }).click();
  await expect(page.locator('.session-link')).toHaveCount(1);
  await expect(page.locator('.workspace-toolbar').getByRole('checkbox', { name: 'Auto-refresh' })).toBeChecked();
  await page.locator('.workspace-toolbar').getByRole('checkbox', { name: 'Auto-refresh' }).uncheck();
  await page.reload();
  await expect(page.locator('.workspace-toolbar').getByRole('checkbox', { name: 'Auto-refresh' })).not.toBeChecked();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: library search, navigation, newest-first timeline, expansion, tool matching, lazy history, chart navigation, filtering, refresh, Markdown safety, mobile layout, and error recovery.');
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
