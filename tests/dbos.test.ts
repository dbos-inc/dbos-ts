import { WorkflowContext, TransactionContext, CommunicatorContext, WorkflowHandle, DBOSTransaction, DBOSWorkflow, DBOSCommunicator, DBOSInitializer, InitContext } from "../src/";
import { generateDBOSTestConfig, setUpDBOSTestDb, TestKvTable } from "./helpers";
import { v1 as uuidv1 } from "uuid";
import { StatusString } from "../src/workflow";
import { DBOSConfig } from "../src/dbos-sdk";
import { PoolClient } from "pg";
import { TestingRuntime, TestingRuntimeImpl, createInternalTestRuntime } from "../src/testing/testing_runtime";
import { transaction_outputs } from "../schemas/user_db_schema";

type TestTransactionContext = TransactionContext<PoolClient>;
const testTableName = "dbos_test_kv";

describe("dbos-tests", () => {
  let username: string;
  let config: DBOSConfig;
  let testRuntime: TestingRuntime;

  beforeAll(async () => {
    config = generateDBOSTestConfig();
    username = config.poolConfig.user || "postgres";
    await setUpDBOSTestDb(config);
  });

  beforeEach(async () => {
    testRuntime = await createInternalTestRuntime([DBOSTestClass, ReadRecording, RetrieveWorkflowStatus], config);
    // await testRuntime.queryUserDB(`DROP TABLE IF EXISTS ${testTableName};`);
    // await testRuntime.queryUserDB(`CREATE TABLE IF NOT EXISTS ${testTableName} (id SERIAL PRIMARY KEY, value TEXT);`);
    DBOSTestClass.cnt = 0;
  });

  afterEach(async () => {
    await testRuntime.destroy();
  });

  test("simple-function", async () => {
    const workflowHandle: WorkflowHandle<string> = await testRuntime.invoke(DBOSTestClass).testWorkflow(username);
    const workflowResult: string = await workflowHandle.getResult();
    expect(JSON.parse(workflowResult)).toEqual({ current_user: username });
  });

  test("return-void", async () => {
    const workflowUUID = uuidv1();
    await testRuntime.invoke(DBOSTestClass, workflowUUID).testVoidFunction();
    await expect(testRuntime.invoke(DBOSTestClass, workflowUUID).testVoidFunction()).resolves.toBeFalsy();
    await expect(testRuntime.invoke(DBOSTestClass, workflowUUID).testVoidFunction()).resolves.toBeFalsy();
  });

  test("tight-loop", async () => {
    for (let i = 0; i < 100; i++) {
      await expect(testRuntime.invoke(DBOSTestClass).testNameWorkflow(username).then((x) => x.getResult())).resolves.toBe(username);
    }
  });

  test("abort-function", async () => {
    for (let i = 0; i < 10; i++) {
      await expect(testRuntime.invoke(DBOSTestClass).testFailWorkflow(username).then((x) => x.getResult())).resolves.toBe(i + 1);
    }

    // Should not appear in the database.
    await expect(testRuntime.invoke(DBOSTestClass).testFailWorkflow("fail").then((x) => x.getResult())).rejects.toThrow("fail");
  });

  test("simple-communicator", async () => {
    const workflowUUID: string = uuidv1();
    await expect(testRuntime.invoke(DBOSTestClass, workflowUUID).testCommunicator()).resolves.toBe(0);
    await expect(testRuntime.invoke(DBOSTestClass).testCommunicator()).resolves.toBe(1);
  });

  test("simple-workflow-notifications", async () => {
    const workflowUUID = uuidv1();
    const handle = await testRuntime.invoke(DBOSTestClass, workflowUUID).receiveWorkflow();
    await expect(testRuntime.invoke(DBOSTestClass).sendWorkflow(handle.getWorkflowUUID()).then((x) => x.getResult())).resolves.toBeFalsy(); // return void.
    expect(await handle.getResult()).toBe(true);
  });

  test("simple-workflow-events", async () => {
    const handle: WorkflowHandle<number> = await testRuntime.invoke(DBOSTestClass).setEventWorkflow();
    const workflowUUID = handle.getWorkflowUUID();
    await handle.getResult();
    await expect(testRuntime.getEvent(workflowUUID, "key1")).resolves.toBe("value1");
    await expect(testRuntime.getEvent(workflowUUID, "key2")).resolves.toBe("value2");
    await expect(testRuntime.getEvent(workflowUUID, "fail", 0)).resolves.toBe(null);
  });

  class ReadRecording {
    static cnt: number = 0;
    static wfCnt: number = 0;

    @DBOSTransaction({ readOnly: true })
    static async testReadFunction(txnCtxt: TestTransactionContext, id: number) {
      const { rows } = await txnCtxt.client.query<TestKvTable>(`SELECT value FROM ${testTableName} WHERE id=$1`, [id]);
      ReadRecording.cnt++;
      await txnCtxt.client.query(`SELECT pg_current_xact_id()`);  // Increase transaction ID, testing if we can capture xid and snapshot correctly.
      if (rows.length === 0) {
        return null;
      }
      return rows[0].value;
    }
  
    @DBOSTransaction()
    static async updateFunction(txnCtxt: TestTransactionContext, id: number, name: string) {
      const { rows } = await txnCtxt.client.query<TestKvTable>(`INSERT INTO ${testTableName} (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value RETURNING value;`, [
        id,
        name,
      ]);
      return rows[0].value;
    }
  
    @DBOSWorkflow()
    static async testRecordingWorkflow(workflowCtxt: WorkflowContext, id: number, name: string) {
      await workflowCtxt.invoke(ReadRecording).testReadFunction(id);
      ReadRecording.wfCnt++;
      await workflowCtxt.invoke(ReadRecording).updateFunction(id, name);
      ReadRecording.wfCnt++;
      // Make sure the workflow actually runs.
      throw Error("dumb test error");
    }
  }

  test("readonly-recording", async () => {
    const workflowUUID = uuidv1();
    // Invoke the workflow, should get the error.
    await expect(testRuntime.invoke(ReadRecording, workflowUUID).testRecordingWorkflow(123, "test").then((x) => x.getResult())).rejects.toThrowError(new Error("dumb test error"));
    expect(ReadRecording.cnt).toBe(1);
    expect(ReadRecording.wfCnt).toBe(2);

    // Invoke it again, should return the recorded same error without running it.
    await expect(testRuntime.invoke(ReadRecording, workflowUUID).testRecordingWorkflow(123, "test").then((x) => x.getResult())).rejects.toThrowError(new Error("dumb test error"));
    expect(ReadRecording.cnt).toBe(1);
    expect(ReadRecording.wfCnt).toBe(2);
  });

  test("txn-snapshot-recording", async () => {
    // Test the recording of transaction snapshot information in our transaction_outputs table.
    const workflowUUID = uuidv1();
    // Invoke the workflow, should get the error.
    await expect(testRuntime.invoke(ReadRecording, workflowUUID).testRecordingWorkflow(123, "test").then((x) => x.getResult())).rejects.toThrowError(new Error("dumb test error"));

    // Check the transaction output table and make sure we record transaction information correctly.
    const readProv = await testRuntime.queryUserDB<transaction_outputs>("SELECT txn_id, txn_snapshot FROM operon.transaction_outputs WHERE workflow_uuid = $1 AND function_id = $2", workflowUUID, 0);
    expect(readProv[0].txn_id).toBeFalsy();
    expect(readProv[0].txn_snapshot).toBeTruthy();

    const writeProv = await testRuntime.queryUserDB<transaction_outputs>("SELECT txn_id, txn_snapshot FROM operon.transaction_outputs WHERE workflow_uuid = $1 AND function_id = $2", workflowUUID, 1);
    expect(writeProv[0].txn_id).toBeTruthy();
    expect(writeProv[0].txn_snapshot).toBeTruthy();

    // Two snapshots must be different because we bumped transaction ID.
    expect(readProv[0].txn_snapshot).not.toEqual(writeProv[0].txn_snapshot);
  });

  class RetrieveWorkflowStatus {
    // Test workflow status changes correctly.
    static resolve1: () => void;
    static promise1 = new Promise<void>((resolve) => {
      RetrieveWorkflowStatus.resolve1 = resolve;
    });

    static resolve2: () => void;
    static promise2 = new Promise<void>((resolve) => {
      RetrieveWorkflowStatus.resolve2 = resolve;
    });

    static resolve3: () => void;
    static promise3 = new Promise<void>((resolve) => {
      RetrieveWorkflowStatus.resolve3 = resolve;
    });

    @DBOSTransaction()
    static async testWriteFunction(txnCtxt: TestTransactionContext, id: number, name: string) {
      const { rows } = await txnCtxt.client.query<TestKvTable>(`INSERT INTO ${testTableName} (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value RETURNING value;`, [
        id,
        name,
      ]);
      return rows[0].value;
    }

    @DBOSWorkflow()
    static async testStatusWorkflow(workflowCtxt: WorkflowContext, id: number, name: string) {
      await RetrieveWorkflowStatus.promise1;
      const value = await workflowCtxt.invoke(RetrieveWorkflowStatus).testWriteFunction(id, name);
      RetrieveWorkflowStatus.resolve3(); // Signal the execution has done.
      await RetrieveWorkflowStatus.promise2;
      return value;
    }
  }

  test("retrieve-workflowstatus", async () => {
    const workflowUUID = uuidv1();

    const workflowHandle = await testRuntime.invoke(RetrieveWorkflowStatus, workflowUUID).testStatusWorkflow(123, "hello");

    expect(workflowHandle.getWorkflowUUID()).toBe(workflowUUID);
    await expect(workflowHandle.getStatus()).resolves.toMatchObject({
      status: StatusString.PENDING,
      workflowName: RetrieveWorkflowStatus.testStatusWorkflow.name,
    });

    RetrieveWorkflowStatus.resolve1();
    await RetrieveWorkflowStatus.promise3;

    // Retrieve handle, should get the pending status.
    await expect(testRuntime.retrieveWorkflow<string>(workflowUUID).getStatus()).resolves.toMatchObject({ status: StatusString.PENDING, workflowName: RetrieveWorkflowStatus.testStatusWorkflow.name });

    // Proceed to the end.
    RetrieveWorkflowStatus.resolve2();
    await expect(workflowHandle.getResult()).resolves.toBe("hello");

    // Flush workflow output buffer so the retrieved handle can proceed and the status would transition to SUCCESS.
    const operon = (testRuntime as TestingRuntimeImpl).getWFE();
    await operon.flushWorkflowStatusBuffer();
    const retrievedHandle = testRuntime.retrieveWorkflow<string>(workflowUUID);
    expect(retrievedHandle).not.toBeNull();
    expect(retrievedHandle.getWorkflowUUID()).toBe(workflowUUID);
    await expect(retrievedHandle.getResult()).resolves.toBe("hello");
    await expect(workflowHandle.getStatus()).resolves.toMatchObject({
      status: StatusString.SUCCESS,
    });
    await expect(retrievedHandle.getStatus()).resolves.toMatchObject({
      status: StatusString.SUCCESS,
    });
  });
});

class DBOSTestClass {

  static initialized = false;
  static cnt: number = 0;

  // eslint-disable-next-line @typescript-eslint/require-await
  @DBOSInitializer()
  static async init(_ctx: InitContext) { 
    DBOSTestClass.initialized = true;
    expect(_ctx.getConfig("counter")).toBe(3);
    await _ctx.queryUserDB(`DROP TABLE IF EXISTS ${testTableName};`);
    await _ctx.queryUserDB(`CREATE TABLE IF NOT EXISTS ${testTableName} (id SERIAL PRIMARY KEY, value TEXT);`);
  }

  @DBOSTransaction()
  static async testFunction(txnCtxt: TestTransactionContext, name: string) {
    expect(txnCtxt.getConfig<number>("counter")).toBe(3);
    const { rows } = await txnCtxt.client.query(`select current_user from current_user where current_user=$1;`, [name]);
    return JSON.stringify(rows[0]);
  }

  @DBOSWorkflow()
  static async testWorkflow(ctxt: WorkflowContext, name: string) {
    expect(DBOSTestClass.initialized).toBe(true);
    expect(ctxt.getConfig<number>("counter")).toBe(3);
    const funcResult = await ctxt.invoke(DBOSTestClass).testFunction(name);
    return funcResult;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  @DBOSTransaction()
  static async testVoidFunction(_txnCtxt: TestTransactionContext) {
    return;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  @DBOSTransaction()
  static async testNameFunction(_txnCtxt: TestTransactionContext, name: string) {
    return name;
  }

  @DBOSWorkflow()
  static async testNameWorkflow(ctxt: WorkflowContext, name: string) {
    return ctxt.invoke(DBOSTestClass).testNameFunction(name);
  }

  @DBOSTransaction()
  static async testFailFunction(txnCtxt: TestTransactionContext, name: string) {
    const { rows } = await txnCtxt.client.query<TestKvTable>(`INSERT INTO ${testTableName}(value) VALUES ($1) RETURNING id`, [name]);
    if (name === "fail") {
      throw new Error("fail");
    }
    return Number(rows[0].id);
  }

  @DBOSTransaction({ readOnly: true })
  static async testKvFunctionRead(txnCtxt: TestTransactionContext, id: number) {
    const { rows } = await txnCtxt.client.query<TestKvTable>(`SELECT id FROM ${testTableName} WHERE id=$1`, [id]);
    if (rows.length > 0) {
      return Number(rows[0].id);
    } else {
      // Cannot find, return a negative number.
      return -1;
    }
  }

  @DBOSWorkflow()
  static async testFailWorkflow(workflowCtxt: WorkflowContext, name: string) {
    expect(DBOSTestClass.initialized).toBe(true);
    const funcResult: number = await workflowCtxt.invoke(DBOSTestClass).testFailFunction(name);
    const checkResult: number = await workflowCtxt.invoke(DBOSTestClass).testKvFunctionRead(funcResult);
    return checkResult;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  @DBOSCommunicator()
  static async testCommunicator(ctxt: CommunicatorContext) {
    expect(ctxt.getConfig<number>("counter")).toBe(3);
    return DBOSTestClass.cnt++;
  }

  @DBOSWorkflow()
  static async receiveWorkflow(ctxt: WorkflowContext) {
    expect(DBOSTestClass.initialized).toBe(true);
    const message1 = await ctxt.recv<string>();
    const message2 = await ctxt.recv<string>();
    const fail = await ctxt.recv("fail", 0);
    return message1 === "message1" && message2 === "message2" && fail === null;
  }

  @DBOSWorkflow()
  static async sendWorkflow(ctxt: WorkflowContext, destinationUUID: string) {
    await ctxt.send(destinationUUID, "message1");
    await ctxt.send(destinationUUID, "message2");
  }


  @DBOSWorkflow()
  static async setEventWorkflow(ctxt: WorkflowContext) {
    await ctxt.setEvent("key1", "value1");
    await ctxt.setEvent("key2", "value2");
    return 0;
  }

}
