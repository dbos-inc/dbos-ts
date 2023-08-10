import {
  ConsoleExporter,
  TelemetrySignal,
  PostgresExporter,
  POSTGRES_EXPORTER,
  TelemetryCollector,
  CONSOLE_EXPORTER,
} from "../src/telemetry";
import { Operon, OperonConfig } from "../src/operon";

import { generateOperonTestConfig, teardownOperonTestDb } from "./helpers";
import { observabilityDBSchema } from "schemas/observability_db_schema";
import { Client } from "pg";

type TelemetrySignalDbFields = {
  workflow_name: string;
  workflow_uuid: string;
  function_id: number;
  function_name: string;
  run_as: string;
  timestamp: bigint;
  severity: string;
  log_message: string;
};

describe("operon-telemetry", () => {
  test("Operon init works with all exporters", async () => {
    const operonConfig = generateOperonTestConfig([
      CONSOLE_EXPORTER,
      POSTGRES_EXPORTER,
    ]);
    const operon = new Operon(operonConfig);
    await operon.init();
    await operon.destroy();
  });

  describe("Console exporter", () => {
    let operon: Operon;
    const operonConfig = generateOperonTestConfig([CONSOLE_EXPORTER]);
    let collector: TelemetryCollector;

    beforeEach(() => {
      operon = new Operon(operonConfig);
    });

    afterEach(async () => {
      await collector.destroy();
      await operon.destroy();
    });

    test("console.log is called with the correct messages", async () => {
      collector = operon.telemetryCollector;
      expect(collector.exporters.length).toBe(1);
      expect(collector.exporters[0]).toBeInstanceOf(ConsoleExporter);

      await collector.init();
      const logSpy = jest.spyOn(global.console, "log");

      // XXX this is a hack: the test will now have to expose registered operations for the collector init() to insert the tables
      const signal1: TelemetrySignal = {
        workflowName: "test",
        workflowUUID: "test",
        functionName: "create_user",
        functionID: 0,
        runAs: "test",
        timestamp: Date.now(),
        severity: "INFO",
        logMessage: "test",
      };
      const signal2 = { ...signal1 };
      signal2.logMessage = "test2";
      collector.push(signal1);
      collector.push(signal2);
      await collector.processAndExportSignals();
      expect(logSpy).toHaveBeenCalledTimes(2);
      expect(logSpy).toHaveBeenNthCalledWith(
        1,
        `[${signal1.severity}] ${signal1.logMessage}`
      );
      expect(logSpy).toHaveBeenNthCalledWith(
        2,
        `[${signal1.severity}] ${signal2.logMessage}`
      );
    });
  });

  describe("Postgres exporter", () => {
    let operon: Operon;
    const operonConfig = generateOperonTestConfig([POSTGRES_EXPORTER]);
    let collector: TelemetryCollector;

    beforeEach(() => {
      operon = new Operon(operonConfig);
    });

    afterEach(async () => {
      await collector.destroy();
      await operon.destroy();
      // This attempts to clear all our DBs, including the observability one
      await teardownOperonTestDb(operonConfig);
    });

    test("Configures and initializes", async () => {
      // First check that the Telemetry Collector is properly initialized with a valid PostgresExporter
      collector = operon.telemetryCollector;
      expect(collector.exporters.length).toBe(1);
      expect(collector.exporters[0]).toBeInstanceOf(PostgresExporter);
      const pgExporter: PostgresExporter = collector
        .exporters[0] as PostgresExporter;

      // Then check PostgresExporter initialization
      const loadSchemaSpy = jest.spyOn(pgExporter.pgClient, "query");
      await collector.init();
      expect(loadSchemaSpy).toHaveBeenCalledWith(observabilityDBSchema);

      // Check the exporter's PG client is functional
      const queryResult = await pgExporter.pgClient.query(
        `select current_user from current_user`
      );
      expect(queryResult.rows).toHaveLength(1);

      await collector.destroy();
    });

    test("Signals are correctly exported", async () => {
      collector = operon.telemetryCollector;
      await collector.init();

      // Push to the signals queue and wait for one export interval
      // XXX this is a hack: the test will now have to expose registered operations for the collector init() to insert the tables
      const signal1: TelemetrySignal = {
        workflowName: "test",
        workflowUUID: "test",
        functionName: "create_user",
        functionID: 0,
        runAs: "test",
        timestamp: Date.now(),
        severity: "INFO",
        logMessage: "test",
      };
      const signal2 = { ...signal1 };
      signal2.logMessage = "test2";
      collector.push(signal1);
      collector.push(signal2);
      await collector.processAndExportSignals();

      const pgExporter = collector.exporters[0] as PostgresExporter;
      const pgExporterPgClient = pgExporter.pgClient;
      const queryResult =
        await pgExporterPgClient.query<TelemetrySignalDbFields>(
          `select * from signal_create_user` // XXX hacked table name
        );
      expect(queryResult.rows).toHaveLength(2);
      expect(queryResult.rows[0].log_message).toBe("test");
      expect(queryResult.rows[1].log_message).toBe("test2");
    });
  });
});
