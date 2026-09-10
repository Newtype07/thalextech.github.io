import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCycleDetail,
  buildCycleAttributionRows,
  buildPortfolioAttributionTimeline,
  computeMaxDrawdown,
  ENTRY_WEEKDAY_EVERY_DAY,
  nextWeeklyExitTs,
  normalizeBacktestConfig,
  prepareBacktestData,
  prepareCycleDetailData,
  requiredQuoteDteDays,
  runWeeklyStraddleBacktest,
  runWeeklyStraddleBacktestBatch,
} from "../src/lib/weeklyStraddleBacktest.js";
import { PRECOMPUTED_DELTA_SCALE } from "../src/lib/optionRisk.js";

const DAY_SECONDS = 86_400;

const buildParityFixture = () => {
  const entryDayTs = Date.UTC(2025, 5, 6, 0) / 1000;
  const expirationTs = Date.UTC(2025, 5, 13, 8) / 1000;
  const instruments = [
    {
      instrumentId: 0,
      name: "BTC-13JUN25-100000-C",
      expirationTs,
      strike: 100_000,
      optionType: "C",
    },
    {
      instrumentId: 1,
      name: "BTC-13JUN25-100000-P",
      expirationTs,
      strike: 100_000,
      optionType: "P",
    },
  ];
  const indexRows = [];
  const quoteSnapshots = [];
  for (let day = 0; day <= 7; day += 1) {
    for (const hour of [8, 9]) {
      const ts = entryDayTs + day * DAY_SECONDS + hour * 3_600;
      const indexPrice = 100_000 + day * 500 + hour;
      indexRows.push({ ts, indexPrice });
      if (ts >= expirationTs) continue;
      const entries = [];
      for (const instrument of instruments) {
        const intradayDeltaShift = hour === 9 ? 0.05 : 0;
        const delta = (instrument.optionType === "C" ? 0.55 : -0.45)
          + intradayDeltaShift;
        entries.push([
          instrument.instrumentId,
          4_000 - day * 250 + instrument.instrumentId * 50,
          0.55,
          delta * PRECOMPUTED_DELTA_SCALE,
        ]);
      }
      quoteSnapshots.push([ts, entries]);
    }
  }
  const config = normalizeBacktestConfig({
    start: new Date(entryDayTs * 1000),
    end: new Date(expirationTs * 1000),
    entryWeekday: 5,
    entryHourUtc: 8,
    hourlyOffset: 8,
    hedgeEnabled: true,
    hedgeIntervalHours: 24,
    holdToExpiry: true,
    targetDteDays: 7,
    minWeeklyDteDays: 4,
    maxWeeklyDteDays: 10,
  });
  return { indexRows, quoteSnapshots, instruments, config };
};

const buildOneDayMaturityFixture = () => {
  const entryTs = Date.UTC(2025, 5, 6, 8) / 1000;
  const oneDayExpirationTs = entryTs + DAY_SECONDS;
  const sevenDayExpirationTs = entryTs + 7 * DAY_SECONDS;
  const instruments = [
    {
      instrumentId: 0,
      name: "BTC-07JUN25-100000-C",
      expirationTs: oneDayExpirationTs,
      strike: 100_000,
      optionType: "C",
    },
    {
      instrumentId: 1,
      name: "BTC-07JUN25-100000-P",
      expirationTs: oneDayExpirationTs,
      strike: 100_000,
      optionType: "P",
    },
    {
      instrumentId: 2,
      name: "BTC-13JUN25-100000-C",
      expirationTs: sevenDayExpirationTs,
      strike: 100_000,
      optionType: "C",
    },
    {
      instrumentId: 3,
      name: "BTC-13JUN25-100000-P",
      expirationTs: sevenDayExpirationTs,
      strike: 100_000,
      optionType: "P",
    },
  ];
  const entryQuotes = instruments.map((instrument) => [
    instrument.instrumentId,
    instrument.expirationTs === oneDayExpirationTs ? 1_300 : 3_800,
    0.55,
    (instrument.optionType === "C" ? 0.52 : -0.48) * PRECOMPUTED_DELTA_SCALE,
  ]);
  const oneDayExitQuotes = instruments
    .filter((instrument) => instrument.expirationTs === sevenDayExpirationTs)
    .map((instrument) => [
      instrument.instrumentId,
      3_500,
      0.54,
      (instrument.optionType === "C" ? 0.54 : -0.46) * PRECOMPUTED_DELTA_SCALE,
    ]);
  const indexRows = [
    { ts: entryTs, indexPrice: 100_000 },
    { ts: oneDayExpirationTs, indexPrice: 101_000 },
    { ts: sevenDayExpirationTs, indexPrice: 102_000 },
  ];
  const quoteSnapshots = [
    [entryTs, entryQuotes],
    [oneDayExpirationTs, oneDayExitQuotes],
  ];
  const config = normalizeBacktestConfig({
    start: new Date(entryTs * 1000),
    end: new Date(sevenDayExpirationTs * 1000),
    entryWeekday: 5,
    entryHourUtc: 8,
    hourlyOffset: 8,
    exitMode: "after_days",
    exitHoldDays: 1,
    hedgeEnabled: false,
    targetDteDays: 1,
    minWeeklyDteDays: 0.25,
    maxWeeklyDteDays: 1.5,
  });
  return {
    indexRows,
    quoteSnapshots,
    instruments,
    config,
    oneDayExpirationTs,
    sevenDayExpirationTs,
  };
};

const buildMultiExpiryEntryHourFixture = () => {
  const startTs = Date.UTC(2025, 5, 6, 0) / 1000;
  const expirationTimestamps = [13, 20, 27, 4].map((day, index) =>
    Date.UTC(2025, index === 3 ? 6 : 5, day, 8) / 1000
  );
  const instruments = expirationTimestamps.flatMap((expirationTs, expirationIndex) => [
    {
      instrumentId: expirationIndex * 2,
      name: `BTC-W${expirationIndex + 1}-100000-C`,
      expirationTs,
      strike: 100_000,
      optionType: "C",
    },
    {
      instrumentId: expirationIndex * 2 + 1,
      name: `BTC-W${expirationIndex + 1}-100000-P`,
      expirationTs,
      strike: 100_000,
      optionType: "P",
    },
  ]);
  const endTs = expirationTimestamps.at(-1) + 3_600;
  const indexRows = [];
  const quoteSnapshots = [];
  for (let ts = startTs; ts <= endTs; ts += DAY_SECONDS) {
    for (const hour of [8, 9]) {
      const observationTs = ts + hour * 3_600;
      if (observationTs > endTs) continue;
      const elapsedDays = Math.floor((observationTs - startTs) / DAY_SECONDS);
      const indexPrice = 100_000 + elapsedDays * 230 + hour * 17;
      indexRows.push({ ts: observationTs, indexPrice });
      const entries = instruments
        .filter((instrument) => instrument.expirationTs > observationTs)
        .map((instrument) => {
          const dteDays = (instrument.expirationTs - observationTs) / DAY_SECONDS;
          const hourPremium = hour === 9 ? 180 : 0;
          const markPrice = 650 + dteDays * 320 + hourPremium + instrument.instrumentId * 11;
          const delta = instrument.optionType === "C" ? 0.55 : -0.45;
          return [
            instrument.instrumentId,
            markPrice,
            0.55,
            delta * PRECOMPUTED_DELTA_SCALE,
          ];
        });
      quoteSnapshots.push([observationTs, entries]);
    }
  }
  const config = normalizeBacktestConfig({
    start: new Date(startTs * 1000),
    end: new Date(endTs * 1000),
    entryWeekday: 5,
    entryHourUtc: 8,
    hourlyOffset: 8,
    exitMode: "after_days",
    exitHoldDays: 7,
    hedgeEnabled: false,
    targetDteDays: 7,
    minWeeklyDteDays: 4,
    maxWeeklyDteDays: 10,
  });
  return { indexRows, quoteSnapshots, instruments, config };
};

test("normalizeBacktestConfig applies defaults and coerces external input once", () => {
  const config = normalizeBacktestConfig({
    entryHourUtc: "12",
    entryWeekday: "2",
    hedgeIntervalHours: "99",
    exitHoldDays: "14.4",
    targetDelta: "-0.35",
    sizingMode: "unsupported",
  });

  assert.equal(config.entryHourUtc, 12);
  assert.equal(config.hourlyOffset, 12);
  assert.equal(config.entryWeekday, 2);
  assert.equal(config.hedgeIntervalHours, 24);
  assert.equal(config.exitHoldDays, 14);
  assert.equal(config.targetDelta, 0.35);
  assert.equal(config.sizingMode, "notional");
  assert.equal(
    normalizeBacktestConfig({ entryWeekday: ENTRY_WEEKDAY_EVERY_DAY }).entryWeekday,
    ENTRY_WEEKDAY_EVERY_DAY,
  );
  assert.equal(requiredQuoteDteDays({ maxWeeklyDteDays: 28 }), 28);
  assert.equal(
    requiredQuoteDteDays({ maxWeeklyDteDays: 10, farTargetDteDays: 30 }),
    10,
  );
  assert.equal(
    requiredQuoteDteDays({
      structure: "calendar_spread",
      maxWeeklyDteDays: 10,
      farTargetDteDays: 30,
    }),
    30,
  );
});

test("notional sizing uses entry spot instead of option strike", () => {
  const fixture = buildParityFixture();
  const result = runWeeklyStraddleBacktest(fixture);
  const cycle = result.cycleSummary[0];
  const expectedQuantity = fixture.config.notionalUsd / cycle.entryIndexPrice;

  assert.notEqual(cycle.entryIndexPrice, cycle.strike);
  assert.ok(cycle.legs.every(
    (leg) => Math.abs(Math.abs(leg.quantity) - expectedQuantity) < 1e-12,
  ));
});

test("weekly exit schedule chooses the next UTC occurrence after entry", () => {
  const friday20 = Date.UTC(2025, 5, 6, 20) / 1000;
  assert.equal(
    nextWeeklyExitTs(friday20, 0, 20),
    Date.UTC(2025, 5, 8, 20) / 1000,
  );
  assert.equal(
    nextWeeklyExitTs(friday20, 5, 20),
    Date.UTC(2025, 5, 13, 20) / 1000,
  );
});

test("weekly schedule exits before expiry and waits for the next entry slot", () => {
  const fixture = buildParityFixture();
  const result = runWeeklyStraddleBacktest({
    ...fixture,
    config: {
      ...fixture.config,
      exitMode: "weekly_schedule",
      exitWeekday: 0,
      exitHourUtc: 8,
    },
  });
  assert.equal(result.cycleSummary.length, 1);
  assert.equal(
    result.cycleSummary[0].exitTs,
    Date.UTC(2025, 5, 8, 8) / 1000,
  );
  assert.equal(result.cycleSummary[0].exitAtExpiry, false);
});

test("fixed-day roll waits for the next configured entry slot after close", () => {
  const fixture = buildMultiExpiryEntryHourFixture();
  const result = runWeeklyStraddleBacktest({
    ...fixture,
    config: {
      ...fixture.config,
      exitMode: "after_days",
      exitHoldDays: 2,
    },
  });
  assert.ok(result.cycleSummary.length > 1);
  assert.ok(result.cycleSummary.every((cycle) =>
    new Date(cycle.entryTs * 1000).getUTCDay() === fixture.config.entryWeekday
  ));
  assert.ok(Math.abs(result.summary.meanHoldingPeriodDays - 2) < 1e-9);
  for (let index = 1; index < result.cycleSummary.length; index += 1) {
    assert.ok(result.cycleSummary[index].entryTs >= result.cycleSummary[index - 1].exitTs);
  }
});

test("a cached full dataset honors a narrower run end date", () => {
  const fixture = buildMultiExpiryEntryHourFixture();
  const preparedData = prepareBacktestData(fixture);
  const narrowConfig = {
    ...fixture.config,
    end: new Date(fixture.config.start.getTime() + 15 * DAY_SECONDS * 1000),
  };
  const cachedRun = runWeeklyStraddleBacktest({
    preparedData,
    config: narrowConfig,
  });
  const isolatedRun = runWeeklyStraddleBacktest({
    indexRows: fixture.indexRows,
    quoteSnapshots: fixture.quoteSnapshots,
    instruments: fixture.instruments,
    config: narrowConfig,
  });

  assert.deepEqual(
    cachedRun.cycleSummary.map((cycle) => cycle.entryTs),
    isolatedRun.cycleSummary.map((cycle) => cycle.entryTs),
  );
  assert.equal(cachedRun.dataEnd.getTime(), narrowConfig.end.getTime());
  assert.ok(cachedRun.counts.closedCycles > 0);
  assert.ok(
    cachedRun.cycleSummary.every(
      (cycle) => cycle.expiration.getTime() <= narrowConfig.end.getTime(),
    ),
  );
});

test("1D maturity selects daily options instead of rolling a 7D option after one day", () => {
  const fixture = buildOneDayMaturityFixture();
  const preparedData = prepareBacktestData(fixture);
  const oneDayResult = runWeeklyStraddleBacktest({
    preparedData,
    config: fixture.config,
  });

  assert.equal(oneDayResult.counts.closedCycles, 1);
  assert.equal(oneDayResult.cycleSummary[0].dteDays, 1);
  assert.equal(oneDayResult.cycleSummary[0].holdingPeriodDays, 1);
  assert.equal(oneDayResult.cycleSummary[0].exitAtExpiry, true);
  assert.equal(oneDayResult.cycleSummary[0].exitTs, fixture.oneDayExpirationTs);
  assert.ok(oneDayResult.cycleSummary[0].legs.every(
    (leg) => leg.expirationTs === fixture.oneDayExpirationTs,
  ));
  assert.ok(oneDayResult.cycleSummary[0].legs.every(
    (leg) => leg.instrumentName.startsWith("BTC-07JUN25"),
  ));

  const dailyRollOfSevenDayResult = runWeeklyStraddleBacktest({
    preparedData,
    config: {
      ...fixture.config,
      targetDteDays: 7,
      minWeeklyDteDays: 4,
      maxWeeklyDteDays: 10,
    },
  });
  assert.equal(dailyRollOfSevenDayResult.counts.closedCycles, 1);
  assert.equal(dailyRollOfSevenDayResult.cycleSummary[0].dteDays, 7);
  assert.equal(dailyRollOfSevenDayResult.cycleSummary[0].holdingPeriodDays, 1);
  assert.equal(dailyRollOfSevenDayResult.cycleSummary[0].exitAtExpiry, false);
  assert.ok(dailyRollOfSevenDayResult.cycleSummary[0].legs.every(
    (leg) => leg.expirationTs === fixture.sevenDayExpirationTs,
  ));
});

test("every-day entry rolls a 1D straddle across consecutive days at the same hour", () => {
  const startDay = Date.UTC(2025, 5, 6, 8) / 1000; // Friday 08:00 UTC
  const instruments = [];
  const indexRows = [];
  const quoteSnapshots = [];
  for (let day = 0; day < 4; day += 1) {
    const entryTs = startDay + day * DAY_SECONDS;
    const expirationTs = entryTs + DAY_SECONDS;
    const callId = day * 2;
    const putId = day * 2 + 1;
    instruments.push(
      {
        instrumentId: callId,
        name: `BTC-D${day}-C`,
        expirationTs,
        strike: 100_000,
        optionType: "C",
      },
      {
        instrumentId: putId,
        name: `BTC-D${day}-P`,
        expirationTs,
        strike: 100_000,
        optionType: "P",
      },
    );
    indexRows.push({ ts: entryTs, indexPrice: 100_000 + day * 200 });
    if (day === 3) {
      indexRows.push({ ts: expirationTs, indexPrice: 100_800 });
    }
    const liveInstruments = instruments.slice(-2);
    quoteSnapshots.push([
      entryTs,
      liveInstruments.map((instrument) => [
        instrument.instrumentId,
        1_200 - day * 20,
        0.5,
        (instrument.optionType === "C" ? 0.52 : -0.48) * PRECOMPUTED_DELTA_SCALE,
      ]),
    ]);
  }

  const config = normalizeBacktestConfig({
    start: new Date(startDay * 1000),
    end: new Date((startDay + 4 * DAY_SECONDS) * 1000),
    entryWeekday: ENTRY_WEEKDAY_EVERY_DAY,
    entryHourUtc: 8,
    hourlyOffset: 8,
    exitMode: "after_days",
    exitHoldDays: 1,
    hedgeEnabled: false,
    targetDteDays: 1,
    minWeeklyDteDays: 0.25,
    maxWeeklyDteDays: 1.5,
  });
  const result = runWeeklyStraddleBacktest({
    indexRows,
    quoteSnapshots,
    instruments,
    config,
  });

  assert.equal(result.counts.closedCycles, 4);
  assert.deepEqual(
    result.cycleSummary.map((cycle) => cycle.entryTs),
    [
      startDay,
      startDay + DAY_SECONDS,
      startDay + 2 * DAY_SECONDS,
      startDay + 3 * DAY_SECONDS,
    ],
  );
  assert.ok(result.cycleSummary.every((cycle) =>
    new Date(cycle.entryTs * 1000).getUTCHours() === 8
    && cycle.holdingPeriodDays === 1
    && cycle.dteDays === 1
  ));
  // Friday through Monday — not Friday-only weekly entries.
  assert.deepEqual(
    result.cycleSummary.map((cycle) => new Date(cycle.entryTs * 1000).getUTCDay()),
    [5, 6, 0, 1],
  );
});

test("fixed-day entry-hour sweeps preserve the selected hour across expiries", () => {
  const { indexRows, quoteSnapshots, instruments, config } = buildMultiExpiryEntryHourFixture();
  const preparedData = prepareBacktestData({
    indexRows,
    quoteSnapshots,
    instruments,
    config,
  });
  const results = [8, 9].map((entryHourUtc) =>
    runWeeklyStraddleBacktest({
      preparedData,
      config: {
        ...config,
        entryHourUtc,
        hourlyOffset: entryHourUtc,
      },
    })
  );

  assert.ok(results.every((result) => result.counts.closedCycles >= 3));
  results.forEach((result, index) => {
    const expectedHour = index === 0 ? 8 : 9;
    assert.ok(result.cycleSummary.every((cycle) =>
      new Date(cycle.entryTs * 1000).getUTCHours() === expectedHour
    ));
  });
  assert.ok(Math.abs(results[0].summary.meanEntryDteDays - 7) < 1e-9);
  assert.ok(Math.abs(results[1].summary.meanEntryDteDays - (7 - 1 / 24)) < 1e-9);
  assert.notDeepEqual(
    results[0].cycleSummary.map((cycle) => cycle.entryTs),
    results[1].cycleSummary.map((cycle) => cycle.entryTs),
  );
  assert.notDeepEqual(
    results[0].cycleSummary.map((cycle) => cycle.cyclePnlUsd),
    results[1].cycleSummary.map((cycle) => cycle.cyclePnlUsd),
  );
});

test("fixed-day entry-weekday sweeps preserve the selected weekday across every cycle", () => {
  const { indexRows, quoteSnapshots, instruments, config } = buildMultiExpiryEntryHourFixture();
  const preparedData = prepareBacktestData({
    indexRows,
    quoteSnapshots,
    instruments,
    config,
  });
  const weekdays = [1, 3, 5];
  const results = weekdays.map((entryWeekday) =>
    runWeeklyStraddleBacktest({
      preparedData,
      config: {
        ...config,
        entryWeekday,
        exitHoldDays: 2,
      },
    })
  );

  assert.ok(results.every((result) => result.counts.closedCycles >= 2));
  results.forEach((result, index) => {
    assert.ok(result.cycleSummary.every((cycle) =>
      new Date(cycle.entryTs * 1000).getUTCDay() === weekdays[index]
    ));
  });
  assert.equal(
    new Set(results.map((result) => JSON.stringify(
      result.cycleSummary.map((cycle) => cycle.entryTs),
    ))).size,
    weekdays.length,
  );
});

test("computeMaxDrawdown returns the largest peak-to-trough loss", () => {
  const rows = [100, 80, 120, 70].map((endingEquityUsd) => ({
    endingEquityUsd,
  }));

  assert.equal(computeMaxDrawdown(rows), -50);
  assert.equal(computeMaxDrawdown([
    rows[0],
    { endingEquityUsd: Number.NaN },
    ...rows.slice(1),
  ]), -50);
  assert.equal(computeMaxDrawdown(), 0);
});

test("portfolio attribution sums overlapping closed cycles and stays reconciled", () => {
  const cycle = (closed, points) => ({ closed, greekPnlTimeline: points });
  const point = (ts, indexPrice, total, delta, gammaTheta, vega, vanna, volga) => ({
    ts,
    indexPrice,
    intervalPnlUsd: total,
    netDeltaPnlUsd: delta,
    gammaThetaPnlUsd: gammaTheta,
    vegaPnlUsd: vega,
    vannaPnlUsd: vanna,
    volgaPnlUsd: volga,
    residualPnlUsd: total - delta - gammaTheta - vega - vanna - volga,
  });
  const rows = buildPortfolioAttributionTimeline([
    cycle(true, [
      point(1, 100, 0, 0, 0, 0, 0, 0),
      point(2, 101, 10, 2, 3, 1, 1, 1),
    ]),
    cycle(true, [
      point(2, 101, 4, 1, 1, 1, 0, 0),
      point(3, 102, -2, -1, 0, 0, 0, 0),
    ]),
    cycle(false, [point(3, 102, 999, 999, 0, 0, 0, 0)]),
  ]);

  assert.deepEqual(rows.map(({ ts, cumulativeTotalPnlUsd }) => ({
    ts,
    cumulativeTotalPnlUsd,
  })), [
    { ts: 1, cumulativeTotalPnlUsd: 0 },
    { ts: 2, cumulativeTotalPnlUsd: 14 },
    { ts: 3, cumulativeTotalPnlUsd: 12 },
  ]);
  for (const row of rows) {
    assert.equal(
      row.cumulativeTotalPnlUsd,
      row.cumulativeNetDeltaPnlUsd
        + row.cumulativeGammaThetaPnlUsd
        + row.cumulativeVegaPnlUsd
        + row.cumulativeVannaPnlUsd
        + row.cumulativeVolgaPnlUsd
        + row.cumulativeResidualPnlUsd,
    );
  }
});

test("cycle attribution rows expose compact reconciled component outcomes", () => {
  const rows = buildCycleAttributionRows([
    {
      cycle: 2,
      entryTs: 10,
      exitTs: 20,
      closed: true,
      cyclePnlUsd: 15,
      greekPnl: {
        netDelta: 2,
        gamma: 3,
        theta: 4,
        vega: 1,
        vanna: -1,
        volga: 2,
        residual: 999,
      },
      attributionSteps: 10,
      meanAttributionIntervalHours: 6,
    },
    {
      cycle: 3,
      entryTs: 20,
      exitTs: 30,
      closed: false,
      cyclePnlUsd: 999,
      greekPnl: { netDelta: 999 },
    },
  ]);

  assert.deepEqual(rows, [{
    cycle: 2,
    entryTs: 10,
    exitTs: 20,
    totalPnlUsd: 15,
    netDeltaPnlUsd: 2,
    gammaPnlUsd: 3,
    thetaPnlUsd: 4,
    gammaThetaPnlUsd: 7,
    vegaPnlUsd: 1,
    vannaPnlUsd: -1,
    volgaPnlUsd: 2,
    residualPnlUsd: 4,
    attributionSteps: 10,
    meanAttributionIntervalHours: 6,
  }]);
});

test("prepareBacktestData retains the index lookup used during preparation", () => {
  const indexRow = {
    ts: 1,
    indexPrice: 100,
  };
  const prepared = prepareBacktestData({
    indexRows: [indexRow],
    quoteSnapshots: [],
    instruments: [],
    config: { end: new Date("2026-01-02T00:00:00Z") },
  });

  assert.equal(prepared.indexes.indexByTs.get(1), indexRow);
  assert.equal("quoteSnapshots" in prepared, false);
  assert.equal("options" in prepared, false);
});

test("aggregate preparation keeps delta-only risk while detail preparation filters full Greeks by plan expiry", () => {
  const ts = Date.UTC(2025, 5, 6, 8) / 1000;
  const expirationTs = Date.UTC(2025, 5, 13, 8) / 1000;
  const otherExpirationTs = Date.UTC(2025, 5, 20, 8) / 1000;
  const indexRows = [{ ts, indexPrice: 100_000 }];
  const instruments = [
    {
      instrumentId: 0,
      name: "BTC-13JUN25-100000-C",
      expirationTs,
      strike: 100_000,
      optionType: "C",
    },
    {
      instrumentId: 1,
      name: "BTC-20JUN25-100000-C",
      expirationTs: otherExpirationTs,
      strike: 100_000,
      optionType: "C",
    },
  ];
  const quoteSnapshots = [[
    ts,
    [
      [0, 4_000, 0.55, 0.55 * PRECOMPUTED_DELTA_SCALE],
      [1, 5_000, 0.6, 0.58 * PRECOMPUTED_DELTA_SCALE],
    ],
  ]];
  const config = { end: new Date(Date.UTC(2025, 5, 13, 8)) };
  const args = { indexRows, quoteSnapshots, instruments, config };
  const aggregate = prepareBacktestData(args);
  const detail = prepareCycleDetailData({
    ...args,
    plan: { legs: [{ expirationTs }] },
  });

  assert.equal(aggregate.quotes.length, 2);
  assert.equal(aggregate.quotes[0].delta, 0.55);
  assert.equal(aggregate.quotes[0].impliedVol, 0.55);
  assert.equal("instrumentName" in aggregate.quotes[0], false);
  assert.equal(
    aggregate.indexes.quoteByTsInstrumentId.get(ts).get(0),
    aggregate.quotes[0],
  );
  assert.equal("gamma" in aggregate.quotes[0], false);
  assert.equal("vega" in aggregate.quotes[0], false);
  assert.equal("theta" in aggregate.quotes[0], false);
  assert.equal(detail.quotes.length, 1);
  assert.equal(detail.quotes[0].expirationTs, expirationTs);
  assert.equal("instrumentName" in detail.quotes[0], false);
  assert.equal(Number.isFinite(detail.quotes[0].gamma), true);
  assert.equal(Number.isFinite(detail.quotes[0].vega), true);
  assert.equal(Number.isFinite(detail.quotes[0].theta), true);
  assert.equal(Number.isFinite(detail.quotes[0].vanna), true);
  assert.equal(Number.isFinite(detail.quotes[0].volga), true);
  assert.equal(detail.quotes[0].impliedVol, 0.55);
});

test("batch runs match independent runs across entry hours", () => {
  const { indexRows, quoteSnapshots, instruments, config } = buildParityFixture();
  const preparedData = prepareBacktestData({
    indexRows,
    quoteSnapshots,
    instruments,
    config,
  });
  const configs = [8, 9].map((hour) => ({
    ...config,
    entryHourUtc: hour,
    hourlyOffset: hour,
  }));
  const independent = configs.map((runConfig) =>
    runWeeklyStraddleBacktest({ preparedData, config: runConfig }),
  );
  const batch = runWeeklyStraddleBacktestBatch({
    preparedData,
    runs: configs.map((runConfig) => ({ config: runConfig })),
  });

  assert.deepEqual(batch, independent);
  assert.ok(batch.every((run) => run.counts.closedCycles === 1));
  assert.ok(batch.every((run) => run.summary.meanEntryImpliedVol === 0.55));
  assert.ok(batch.every((run) =>
    Math.abs(
      run.summary.cumulativeOptionPnlUsd +
      run.summary.cumulativeHedgePnlUsd -
      run.summary.finalEquityUsd
    ) < 1e-9
  ));

  const selectedPlan = batch[0].cycleSummary[0];
  assert.ok(Number.isFinite(selectedPlan.exitIndexPrice));
  assert.ok(selectedPlan.legs.every((leg) =>
    Number.isInteger(leg.instrumentId) && leg.instrumentName.startsWith("BTC-")
  ));
  const sampledPrices = Array.from({ length: 8 }, (_, day) => 100_008 + day * 500);
  const sampledVariance = sampledPrices.slice(1).reduce((variance, price, index) => {
    const sampledReturn = Math.log(price / sampledPrices[index]);
    return variance + sampledReturn ** 2;
  }, 0);
  const expectedSampledVol = Math.sqrt(sampledVariance / (7 / 365));
  assert.ok(Math.abs(selectedPlan.sampledRealizedVol - expectedSampledVol) < 1e-12);
  assert.ok(Math.abs(batch[0].summary.meanSampledRealizedVol - expectedSampledVol) < 1e-12);

  const earlyExit = runWeeklyStraddleBacktest({
    preparedData,
    config: {
      ...configs[0],
      exitMode: "after_days",
      holdToExpiry: false,
      exitHoldDays: 2,
    },
  }).cycleSummary[0];
  assert.ok(earlyExit.legs.every((leg) => Number.isFinite(leg.exitPrice)));
  assert.ok(earlyExit.legs.every((leg) => leg.exitImpliedVol === 0.55));
  assert.ok(earlyExit.legs.every((leg) => Number.isFinite(leg.exitDelta)));
  assert.equal(
    earlyExit.exitOptionMarketValueUsd,
    earlyExit.legs.reduce((value, leg) => value + leg.quantity * leg.exitPrice, 0),
  );

  const unhedged = runWeeklyStraddleBacktest({
    preparedData,
    config: { ...configs[0], hedgeEnabled: false },
  });
  assert.ok(
    Math.abs(
      unhedged.cycleSummary[0].sampledRealizedVol -
      expectedSampledVol,
    ) < 1e-12,
  );
  assert.equal(unhedged.cycleSummary[0].sampledPathIntervalHours, 24);

  const detailPrepared = prepareCycleDetailData({
    indexRows,
    quoteSnapshots,
    instruments,
    config: configs[0],
    plan: selectedPlan,
  });
  const detailRows = buildCycleDetail({
    plan: selectedPlan,
    preparedData: detailPrepared,
    config: configs[0],
  });
  assert.ok(
    Math.abs(detailRows.at(-1).hedgePnlUsd - selectedPlan.hedgePnlUsd) < 1e-7,
  );

  const hourlyDetailRows = buildCycleDetail({
    plan: selectedPlan,
    preparedData: detailPrepared,
    config: { ...configs[0], hedgeIntervalHours: 1 },
  });
  assert.ok(
    hourlyDetailRows.filter((row) => row.hedgeTrade).length
      > detailRows.filter((row) => row.hedgeTrade).length,
  );

  const attributed = runWeeklyStraddleBacktest({
    preparedData,
    config: { ...configs[0], includeGreekAttribution: true },
  });
  const attributedCycle = attributed.cycleSummary[0];
  assert.deepEqual(Object.keys(attributedCycle.greekPnl), [
    "netDelta", "theta", "gamma", "vega", "vanna", "volga", "residual",
  ]);
  assert.ok(attributedCycle.attributionSteps > 0);
  const attributedTotal = Object.values(attributedCycle.greekPnl)
    .reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(attributedTotal - attributedCycle.cyclePnlUsd) < 1e-9);
  assert.ok(attributedCycle.greekPnlTimeline.length > 1);
  assert.equal(attributedCycle.greekPnlTimeline[0].intervalPnlUsd, 0);
  const timelineTotal = attributedCycle.greekPnlTimeline
    .reduce((sum, point) => sum + point.intervalPnlUsd, 0);
  const timelineResidual = attributedCycle.greekPnlTimeline
    .reduce((sum, point) => sum + point.residualPnlUsd, 0);
  assert.ok(Math.abs(timelineTotal - attributedCycle.cyclePnlUsd) < 1e-9);
  assert.ok(Math.abs(timelineResidual - attributedCycle.greekPnl.residual) < 1e-9);
});

for (const priceStep of [-2_000, 2_000]) {
  for (const exitMode of ['expiry', 'after_days']) {
    test(`covered call includes fixed underlying at ${exitMode}, spot step ${priceStep}`, () => {
      const fixture = buildParityFixture();
      const entryTs = fixture.indexRows[0].ts;
      fixture.indexRows = fixture.indexRows.map(row => ({
        ...row,
        indexPrice: 100_000 + priceStep * (row.ts - entryTs) / DAY_SECONDS,
      }));
      const config = {
        ...fixture.config,
        structure: 'covered_call',
        longOption: true,
        hedgeEnabled: true,
        sizingMode: 'btc',
        btcQuantity: 2,
        exitMode,
        exitHoldDays: 2,
      };
      const result = runWeeklyStraddleBacktest({ ...fixture, config });
      const cycle = result.cycleSummary[0];
      assert.ok(cycle.closed);
      assert.equal(cycle.legs.length, 1);
      assert.equal(cycle.legs[0].optionType, 'C');
      assert.equal(cycle.legs[0].quantity, -1);
      assert.equal(cycle.underlyingQuantity, 1);
      assert.equal(cycle.hedgeEnabled, false);
      const underlyingPnl = cycle.holdingEndPrice - cycle.holdingStartPrice;
      assert.equal(cycle.hedgePnlUsd, underlyingPnl);
      assert.equal(cycle.cyclePnlUsd, cycle.shortOptionPnlUsd + underlyingPnl);
      if (exitMode === 'expiry') {
        const payoff = (cycle.legs[0].entryPrice
          + Math.min(cycle.exitIndexPrice, cycle.legs[0].strike) - cycle.entryIndexPrice);
        assert.ok(Math.abs(cycle.cyclePnlUsd - payoff) < 1e-8);
      }
      const preparedData = prepareCycleDetailData({ ...fixture, config, plan: cycle });
      const detail = buildCycleDetail({ plan: cycle, preparedData, config });
      assert.ok(detail.every(row => row.hedgeQuantity === 1));
      assert.equal(detail.at(-1).hedgeQuantity, 1);
      assert.ok(Math.abs(detail.at(-1).totalPnlUsd - cycle.cyclePnlUsd) < 1e-8);
    });
  }
}

const buildVerticalFixture = (optionType, exitSpot = 100_000) => {
  const entryTs = Date.UTC(2025, 5, 6, 8) / 1000;
  const expirationTs = entryTs + 7 * DAY_SECONDS;
  const sign = optionType === 'C' ? 1 : -1;
  const instruments = [0, 1, 2].map(instrumentId => ({
    instrumentId, name: `spread-${optionType}-${instrumentId}`, optionType,
    strike: 100_000 + sign * (instrumentId + 1) * 5_000, expirationTs,
  }));
  return {
    instruments,
    indexRows: [{ ts: entryTs, indexPrice: 100_000 },
      { ts: entryTs + 2 * DAY_SECONDS, indexPrice: 101_000 },
      { ts: expirationTs, indexPrice: exitSpot }],
    quoteSnapshots: [
      [entryTs, instruments.map((row, i) => [i, [2000, 900, 400][i], 0.55,
        sign * [0.25, 0.15, 0.1][i] * PRECOMPUTED_DELTA_SCALE])],
      [entryTs + 2 * DAY_SECONDS, instruments.map((row, i) => [i, [1800, 800, 300][i], 0.55,
        sign * [0.25, 0.15, 0.1][i] * PRECOMPUTED_DELTA_SCALE])],
    ],
    config: { start: new Date(entryTs * 1000), end: new Date(expirationTs * 1000),
      structure: optionType === 'C' ? 'call_spread' : 'put_spread',
      entryWeekday: 5, entryHourUtc: 8, exitMode: 'expiry', hedgeEnabled: false,
      sizingMode: 'btc', btcQuantity: 2, targetDelta: 0.25, wingDelta: 0.1 },
  };
};

for (const type of ['C', 'P']) {
  test(`${type} spread selects ordered same-expiry strikes and bounded expiry payoff`, () => {
    for (const spot of [70_000, 90_000, 100_000, 110_000, 130_000]) {
      for (const longOption of [false, true]) {
        const fixture = buildVerticalFixture(type, spot);
        const run = runWeeklyStraddleBacktest({ ...fixture, config: { ...fixture.config, longOption } });
        const cycle = run.cycleSummary[0];
        assert.ok(cycle.closed);
        const [near, wing] = cycle.legs;
        assert.equal(near.instrumentId, 0);
        assert.equal(wing.instrumentId, 2);
        assert.equal(near.expirationTs, wing.expirationTs);
        assert.equal(near.quantity, longOption ? 2 : -2);
        assert.equal(wing.quantity, -near.quantity);
        const intrinsic = strike => Math.max(type === 'C' ? spot - strike : strike - spot, 0);
        const expected = near.quantity * (intrinsic(near.strike) - near.entryPrice)
          + wing.quantity * (intrinsic(wing.strike) - wing.entryPrice);
        assert.equal(cycle.cyclePnlUsd, expected);
        assert.ok(Math.abs(expected) <= 2 * Math.abs(wing.strike - near.strike));
      }
    }
  });
  test(`${type} spread closes early using both marks and sizes by notional`, () => {
    const fixture = buildVerticalFixture(type);
    const config = { ...fixture.config, exitMode: 'after_days', exitHoldDays: 2,
      sizingMode: 'notional', notionalUsd: 50_000 };
    const cycle = runWeeklyStraddleBacktest({ ...fixture, config }).cycleSummary[0];
    assert.equal(cycle.legs[0].quantity, -0.5);
    assert.equal(cycle.legs[1].quantity, 0.5);
    assert.equal(cycle.cyclePnlUsd, 50);
    const preparedData = prepareCycleDetailData({ ...fixture, config, plan: cycle });
    assert.equal(buildCycleDetail({ plan: cycle, preparedData, config }).at(-1).totalPnlUsd, 50);
  });
  test(`${type} spread skips chains with only one eligible strike`, () => {
    const fixture = buildVerticalFixture(type);
    fixture.quoteSnapshots = fixture.quoteSnapshots.map(([ts, rows]) => [ts, rows.slice(0, 1)]);
    assert.equal(runWeeklyStraddleBacktest(fixture).cycleSummary.length, 0);
  });
}

test('vertical spread delta targets must be positive and ordered', () => {
  for (const wingDelta of [0, 0.25, 0.3, NaN]) {
    assert.throws(() => normalizeBacktestConfig({ structure: 'call_spread', targetDelta: 0.25, wingDelta }), RangeError);
  }
});

test('spread selection remains distinct and deterministic when both targets prefer one strike', () => {
  const fixture = buildVerticalFixture('C');
  fixture.config.targetDelta = 0.2;
  fixture.config.wingDelta = 0.19;
  const select = input => runWeeklyStraddleBacktest(input).cycleSummary[0].legs.map(leg => leg.strike);
  const strikes = select(fixture);
  assert.ok(strikes[1] > strikes[0]);
  fixture.quoteSnapshots = fixture.quoteSnapshots.map(([ts, rows]) => [ts, [...rows].reverse()]);
  assert.deepEqual(select(fixture), strikes);
});

test('covered call carries one unit across entry gaps and the final uncovered period', () => {
  const fixture = buildMultiExpiryEntryHourFixture();
  const first = fixture.indexRows[0];
  // Add an observed price before the first call, then leave five-day gaps at rolls.
  fixture.indexRows.unshift({ ts: first.ts - 3_600, indexPrice: 80_000 });
  const config = { ...fixture.config, structure: 'covered_call', sizingMode: 'notional',
    notionalUsd: 500_000, btcQuantity: 3, exitHoldDays: 2, includeGreekAttribution: true };
  const result = runWeeklyStraddleBacktest({ ...fixture, config });
  const cycles = result.cycleSummary;
  assert.ok(cycles.length > 1);
  assert.ok(cycles.every(cycle => cycle.underlyingQuantity === 1 && cycle.legs[0].quantity === -1));
  const initialSpot = fixture.indexRows[0].indexPrice;
  const finalSpot = fixture.indexRows.at(-1).indexPrice;
  assert.equal(result.summary.initialInvestmentUsd, initialSpot);
  assert.equal(result.summary.cumulativeHedgePnlUsd, finalSpot - initialSpot);
  assert.equal(result.summary.finalEquityUsd,
    result.summary.cumulativeOptionPnlUsd + finalSpot - initialSpot);
  assert.equal(result.summary.cumulativeReturnOnNotional, result.summary.finalEquityUsd / initialSpot);
  assert.ok(cycles.every(cycle => cycle.investmentUsd === initialSpot));
  assert.equal(cycles.at(-1).holdingEndTs, fixture.indexRows.at(-1).ts);
  const timeline = buildPortfolioAttributionTimeline(cycles);
  assert.ok(Math.abs(timeline.at(-1).cumulativeTotalPnlUsd - result.summary.finalEquityUsd) < 1e-7);
  const gapPoint = timeline.find(point => point.ts > cycles[0].exitTs && point.ts < cycles[1].entryTs);
  assert.ok(gapPoint);
  for (const cycle of cycles) {
    const preparedData = prepareCycleDetailData({ ...fixture, config, plan: cycle });
    const detail = buildCycleDetail({ plan: cycle, preparedData, config });
    assert.ok(detail.every(row => row.hedgeQuantity === 1 && row.hedgeTrade?.side !== 'sell'));
    assert.ok(detail.every(row => row.dateTime.getTime() === row.ts * 1000));
    assert.equal(detail.filter(row => row.hedgeTrade).length, cycle.cycle === 1 ? 1 : 0);
    assert.ok(Math.abs(detail.at(-1).totalPnlUsd - cycle.cyclePnlUsd) < 1e-7);
  }
  const preparedData = prepareBacktestData({ ...fixture, config });
  const batch = runWeeklyStraddleBacktestBatch({ preparedData, runs: [{ config }] });
  assert.equal(batch[0].summary.finalEquityUsd, result.summary.finalEquityUsd);
});

test('fixed-unit aggregate return uses the initial cycle investment', () => {
  const fixture = buildMultiExpiryEntryHourFixture();
  const result = runWeeklyStraddleBacktest({ ...fixture,
    config: { ...fixture.config, sizingMode: 'btc', btcQuantity: 1 } });
  assert.equal(result.summary.cumulativeReturnOnNotional,
    result.summary.finalEquityUsd / result.cycleSummary[0].investmentUsd);
});
