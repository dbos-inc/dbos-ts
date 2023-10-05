import {
  Operon,
  WorkflowContext,
  TransactionContext,
  CommunicatorContext,
  WorkflowHandle,
} from "../src/";
import {
  generateOperonTestConfig,
  setupOperonTestDb,
  TestKvTable,
} from "./helpers";
import { v1 as uuidv1 } from "uuid";
import { sleep } from "../src/utils";
import { StatusString } from "../src/workflow";
import { OperonConfig } from "../src/operon";
import { PoolClient } from "pg";

describe("operon-tests", () => {
  const testTableName = "operon_test_kv";

  let operon: Operon;
  let username: string;
  let config: OperonConfig;

  beforeAll(async () => {
    config = generateOperonTestConfig();
    username = config.poolConfig.user || "postgres";
    await setupOperonTestDb(config);
  });

  beforeEach(async () => {
    operon = new Operon(config);
    await operon.init();
    await operon.userDatabase.query(`DROP TABLE IF EXISTS ${testTableName};`);
    await operon.userDatabase.query(
      `CREATE TABLE IF NOT EXISTS ${testTableName} (id SERIAL PRIMARY KEY, value TEXT);`
    );
  });

  afterEach(async () => {
    await operon.destroy();
  });

  test("simple-function", async () => {
    const testFunction = async (txnCtxt: TransactionContext<PoolClient>, name: string) => {
      const { rows } = await txnCtxt.client.query(
        `select current_user from current_user where current_user=$1;`,
        [name]
      );
      await sleep(10);
      return JSON.stringify(rows[0]);
    };
    operon.registerTransaction(testFunction);

    const testWorkflow = async (
      workflowCtxt: WorkflowContext,
      name: string
    ) => {
      const funcResult: string = await workflowCtxt.transaction(
        testFunction,
        name
      );
      return funcResult;
    };

    operon.registerWorkflow(testWorkflow);

    const workflowHandle: WorkflowHandle<string> = await operon.workflow(
      testWorkflow,
      {},
      username
    );
    expect(typeof workflowHandle.getWorkflowUUID()).toBe("string");
    await expect(workflowHandle.getStatus()).resolves.toMatchObject({
      status: StatusString.PENDING,
      workflowName: testWorkflow.name
    });
    const workflowResult: string = await workflowHandle.getResult();
    expect(JSON.parse(workflowResult)).toEqual({ current_user: username });

    await operon.flushWorkflowStatusBuffer();
    await expect(workflowHandle.getStatus()).resolves.toMatchObject({
      status: StatusString.SUCCESS,
    });
    const retrievedHandle = operon.retrieveWorkflow<string>(
      workflowHandle.getWorkflowUUID()
    );
    expect(retrievedHandle).not.toBeNull();
    await expect(retrievedHandle.getStatus()).resolves.toMatchObject({
      status: StatusString.SUCCESS,
    });
    expect(JSON.parse(await retrievedHandle.getResult())).toEqual({
      current_user: username,
    });
  });

  test("return-void", async () => {
    const testFunction = async (txnCtxt: TransactionContext<PoolClient>) => {
      void txnCtxt;
      await sleep(1);
      return;
    };
    operon.registerTransaction(testFunction);
    const workflowUUID = uuidv1();
    await operon.transaction(testFunction, { workflowUUID: workflowUUID });
    await expect(
      operon.transaction(testFunction, { workflowUUID: workflowUUID })
    ).resolves.toBeFalsy();
    await expect(
      operon.transaction(testFunction, { workflowUUID: workflowUUID })
    ).resolves.toBeFalsy();
    await expect(
      operon.transaction(testFunction, { workflowUUID: workflowUUID })
    ).resolves.toBeFalsy();
  });

  test("tight-loop", async () => {
    const testFunction = async (txnCtxt: TransactionContext<PoolClient>, name: string) => {
      void txnCtxt;
      await sleep(1);
      return name;
    };
    operon.registerTransaction(testFunction);

    const testWorkflow = async (
      workflowCtxt: WorkflowContext,
      name: string
    ) => {
      const funcResult: string = await workflowCtxt.transaction(
        testFunction,
        name
      );
      return funcResult;
    };
    operon.registerWorkflow(testWorkflow);

    for (let i = 0; i < 100; i++) {
      await expect(
        operon.workflow(testWorkflow, {}, username).then(x => x.getResult())
      ).resolves.toBe(username);
    }
  });

  test("abort-function", async () => {
    const testFunction = async (txnCtxt: TransactionContext<PoolClient>, name: string) => {
      const { rows } = await txnCtxt.client.query<TestKvTable>(
        `INSERT INTO ${testTableName}(value) VALUES ($1) RETURNING id`,
        [name]
      );
      if (name === "fail") {
        throw new Error("fail");
      }
      return Number(rows[0].id);
    };
    operon.registerTransaction(testFunction);

    const testFunctionRead = async (
      txnCtxt: TransactionContext<PoolClient>,
      id: number
    ) => {
      const { rows } = await txnCtxt.client.query<TestKvTable>(
        `SELECT id FROM ${testTableName} WHERE id=$1`,
        [id]
      );
      if (rows.length > 0) {
        return Number(rows[0].id);
      } else {
        // Cannot find, return a negative number.
        return -1;
      }
    };
    operon.registerTransaction(testFunctionRead);

    const testWorkflow = async (
      workflowCtxt: WorkflowContext,
      name: string
    ) => {
      const funcResult: number = await workflowCtxt.transaction(
        testFunction,
        name
      );
      const checkResult: number = await workflowCtxt.transaction(
        testFunctionRead,
        funcResult
      );
      return checkResult;
    };
    operon.registerWorkflow(testWorkflow);

    for (let i = 0; i < 10; i++) {
      await expect(
        operon.workflow(testWorkflow, {}, username).then(x => x.getResult())
      ).resolves.toBe(i + 1);
    }

    // Should not appear in the database.
    await expect(
      operon.workflow(testWorkflow, {}, "fail").then(x => x.getResult())
    ).rejects.toThrow("fail");
  });

  test("oaoo-simple", async () => {
    const testFunction = async (txnCtxt: TransactionContext<PoolClient>, name: string) => {
      const { rows } = await txnCtxt.client.query<TestKvTable>(
        `INSERT INTO ${testTableName}(value) VALUES ($1) RETURNING id`,
        [name]
      );
      return Number(rows[0].id);
    };
    operon.registerTransaction(testFunction);

    const testFunctionRead = async (
      txnCtxt: TransactionContext<PoolClient>,
      id: number
    ) => {
      const { rows } = await txnCtxt.client.query<TestKvTable>(
        `SELECT id FROM ${testTableName} WHERE id=$1`,
        [id]
      );
      if (rows.length > 0) {
        return Number(rows[0].id);
      } else {
        // Cannot find, return a negative number.
        return -1;
      }
    };
    operon.registerTransaction(testFunctionRead);

    const testWorkflow = async (
      workflowCtxt: WorkflowContext,
      name: string
    ) => {
      const funcResult: number = await workflowCtxt.transaction(
        testFunction,
        name
      );
      const checkResult: number = await workflowCtxt.transaction(
        testFunctionRead,
        funcResult
      );
      return checkResult;
    };
    operon.registerWorkflow(testWorkflow);

    let workflowResult: number;
    const uuidArray: string[] = [];
    for (let i = 0; i < 10; i++) {
      const workflowUUID: string = uuidv1();
      uuidArray.push(workflowUUID);
      workflowResult = await operon
        .workflow(testWorkflow, { workflowUUID: workflowUUID }, username)
        .then(x => x.getResult());
      expect(workflowResult).toEqual(i + 1);
    }

    // Rerunning with the same workflow UUID should return the same output.
    for (let i = 0; i < 10; i++) {
      const workflowUUID: string = uuidArray[i];
      const workflowResult: number = await operon
        .workflow(testWorkflow, { workflowUUID: workflowUUID }, username)
        .then(x => x.getResult());
      expect(workflowResult).toEqual(i + 1);
    }
  });

  test("simple-communicator", async () => {
    let counter = 0;
    const testCommunicator = async (commCtxt: CommunicatorContext) => {
      void commCtxt;
      await sleep(1);
      return counter++;
    };
    operon.registerCommunicator(testCommunicator);

    const testWorkflow = async (workflowCtxt: WorkflowContext) => {
      const funcResult = await workflowCtxt.external(testCommunicator);
      return funcResult ?? -1;
    };
    operon.registerWorkflow(testWorkflow);

    const workflowUUID: string = uuidv1();

    let result: number = await operon
      .workflow(testWorkflow, { workflowUUID: workflowUUID })
      .then(x => x.getResult());
    expect(result).toBe(0);

    // Test OAOO. Should return the original result.
    result = await operon
      .workflow(testWorkflow, { workflowUUID: workflowUUID })
      .then(x => x.getResult());
    expect(result).toBe(0);
  });

  test("simple-workflow-notifications", async () => {
    const receiveWorkflow = async (ctxt: WorkflowContext) => {
      const message1 = await ctxt.recv<string>();
      const message2 = await ctxt.recv<string>();
      const fail = await ctxt.recv("fail", 0);
      return message1 === "message1" && message2 === "message2" && fail === null;
    };
    operon.registerWorkflow(receiveWorkflow);

    const sendWorkflow = async (ctxt: WorkflowContext, destinationUUID: string) => {
      await ctxt.send(destinationUUID, "message1");
      await ctxt.send(destinationUUID, "message2");
    };
    operon.registerWorkflow(sendWorkflow);

    const workflowUUID = uuidv1();
    const handle = await operon
      .workflow(receiveWorkflow, { workflowUUID: workflowUUID });
    await operon.workflow(sendWorkflow, {}, handle.getWorkflowUUID()).then(x => x.getResult());
    expect(await handle.getResult()).toBe(true);
    const retry = await operon
      .workflow(receiveWorkflow, { workflowUUID: workflowUUID })
      .then(x => x.getResult());
    expect(retry).toBe(true);
  });

  test("notification-oaoo", async () => {
    const recvWorkflowUUID = uuidv1();
    const idempotencyKey = "test-suffix"
    const receiveWorkflow = async (ctxt: WorkflowContext, topic: string, timeout: number) => {
      // This returns true if and only if exactly one message is sent to it.
      const succeeds = await ctxt.recv<number>(topic, timeout);
      const fails = await ctxt.recv<number>(topic, 0);
      return succeeds === 123 && fails === null;
    };
    operon.registerWorkflow(receiveWorkflow);

    // Send twice with the same idempotency key.  Only one message should be sent.
    await expect(operon.send(recvWorkflowUUID, 123, "testTopic", idempotencyKey)).resolves.not.toThrow();
    await expect(operon.send(recvWorkflowUUID, 123, "testTopic", idempotencyKey)).resolves.not.toThrow();

    // Receive twice with the same UUID.  Each should get the same result of true.
    await expect(operon.workflow(receiveWorkflow, { workflowUUID: recvWorkflowUUID }, "testTopic", 1).then(x => x.getResult())).resolves.toBe(true);
    await expect(operon.workflow(receiveWorkflow, { workflowUUID: recvWorkflowUUID }, "testTopic", 1).then(x => x.getResult())).resolves.toBe(true);

    // A receive with a different UUID should return false.
    await expect(operon.workflow(receiveWorkflow, {}, "testTopic", 0).then(x => x.getResult())).resolves.toBe(false);
  });

  test("endtoend-oaoo", async () => {
    let num = 0;

    const testFunction = async (txnCtxt: TransactionContext<PoolClient>, code: number) => {
      void txnCtxt;
      await sleep(1);
      return code + 1;
    };

    const testWorkflow = async (
      workflowCtxt: WorkflowContext,
      code: number
    ) => {
      const funcResult: number = await workflowCtxt.transaction(
        testFunction,
        code
      );
      num += 1;
      return funcResult;
    };
    operon.registerTransaction(testFunction, { readOnly: true });
    operon.registerWorkflow(testWorkflow);

    const workflowUUID = uuidv1();
    await expect(
      operon
        .workflow(testWorkflow, { workflowUUID: workflowUUID }, 10)
        .then(x => x.getResult())
    ).resolves.toBe(11);
    expect(num).toBe(1);

    await operon.flushWorkflowStatusBuffer();
    // Run it again with the same UUID, should get the same output.
    await expect(
      operon
        .workflow(testWorkflow, { workflowUUID: workflowUUID }, 10)
        .then(x => x.getResult())
    ).resolves.toBe(11);
    // The workflow should not run at all.
    expect(num).toBe(1);
  });

  test("simple-workflow-events", async () => {
    const sendWorkflow = async (ctxt: WorkflowContext) => {
      await ctxt.setEvent("key1", "value1");
      await ctxt.setEvent("key2", "value2");
      return 0;
    };
    operon.registerWorkflow(sendWorkflow);

    const handle: WorkflowHandle<number> = await operon.workflow(sendWorkflow, {});
    const workflowUUID = handle.getWorkflowUUID();
    await expect(operon.getEvent(workflowUUID, "key1")).resolves.toBe("value1");
    await expect(operon.getEvent(workflowUUID, "key2")).resolves.toBe("value2");
    await expect(operon.getEvent(workflowUUID, "fail", 0)).resolves.toBe(null);
    await handle.getResult();
    await expect(operon.workflow(sendWorkflow, {workflowUUID: workflowUUID}).then(x => x.getResult())).resolves.toBe(0);
  });

  test("readonly-recording", async () => {
    let num = 0;
    let workflowCnt = 0;

    const readFunction = async (txnCtxt: TransactionContext<PoolClient>, id: number) => {
      const { rows } = await txnCtxt.client.query<TestKvTable>(
        `SELECT value FROM ${testTableName} WHERE id=$1`,
        [id]
      );
      num += 1;
      if (rows.length === 0) {
        return null;
      }
      return rows[0].value;
    };
    operon.registerTransaction(readFunction, { readOnly: true });

    const writeFunction = async (
      txnCtxt: TransactionContext<PoolClient>,
      id: number,
      name: string
    ) => {
      const { rows } = await txnCtxt.client.query<TestKvTable>(
        `INSERT INTO ${testTableName} (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value RETURNING value;`,
        [id, name]
      );
      return rows[0].value;
    };
    operon.registerTransaction(writeFunction, {});

    const testWorkflow = async (
      workflowCtxt: WorkflowContext,
      id: number,
      name: string
    ) => {
      await workflowCtxt.transaction(readFunction, id);
      workflowCnt += 1;
      await workflowCtxt.transaction(writeFunction, id, name);
      workflowCnt += 1; // Make sure the workflow actually runs.
      throw Error("dumb test error");
    };
    operon.registerWorkflow(testWorkflow, {});

    const workflowUUID = uuidv1();

    // Invoke the workflow, should get the error.
    await expect(
      operon
        .workflow(testWorkflow, { workflowUUID: workflowUUID }, 123, "test")
        .then(x => x.getResult())
    ).rejects.toThrowError(new Error("dumb test error"));
    expect(num).toBe(1);
    expect(workflowCnt).toBe(2);

    // Invoke it again, should return the recorded same error.
    await expect(
      operon
        .workflow(testWorkflow, { workflowUUID: workflowUUID }, 123, "test")
        .then(x => x.getResult())
    ).rejects.toThrowError(new Error("dumb test error"));
    expect(num).toBe(1);
    expect(workflowCnt).toBe(2);
  });

  test("retrieve-workflowstatus", async () => {
    // Test workflow status changes correctly.
    let resolve1: () => void;
    const promise1 = new Promise<void>((resolve) => {
      resolve1 = resolve;
    });

    let resolve2: () => void;
    const promise2 = new Promise<void>((resolve) => {
      resolve2 = resolve;
    });

    let resolve3: () => void;
    const promise3 = new Promise<void>((resolve) => {
      resolve3 = resolve;
    });

    const writeFunction = async (
      txnCtxt: TransactionContext<PoolClient>,
      id: number,
      name: string
    ) => {
      const { rows } = await txnCtxt.client.query<TestKvTable>(
        `INSERT INTO ${testTableName} (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value RETURNING value;`,
        [id, name]
      );
      return rows[0].value!;
    };
    operon.registerTransaction(writeFunction, {});

    const testWorkflow = async (
      workflowCtxt: WorkflowContext,
      id: number,
      name: string
    ) => {
      await promise1;
      const value = await workflowCtxt.transaction(writeFunction, id, name);
      resolve3(); // Signal the execution has done.
      await promise2;
      return value;
    };
    operon.registerWorkflow(testWorkflow, {});

    const workflowUUID = uuidv1();

    const workflowHandle = await operon.workflow(
      testWorkflow,
      { workflowUUID: workflowUUID },
      123,
      "hello"
    );

    expect(workflowHandle.getWorkflowUUID()).toBe(workflowUUID);
    await expect(workflowHandle.getStatus()).resolves.toMatchObject({
      status: StatusString.PENDING,
      workflowName: testWorkflow.name
    });

    resolve1!();
    await promise3;

    // Retrieve handle, should get the pending status.
    await expect(
      operon.retrieveWorkflow<string>(workflowUUID).getStatus()
    ).resolves.toMatchObject({ status: StatusString.PENDING, workflowName: testWorkflow.name });

    // Proceed to the end.
    resolve2!();
    await expect(workflowHandle.getResult()).resolves.toBe("hello");

    // Flush workflow output buffer so the retrieved handle can proceed and the status would transition to SUCCESS.
    await operon.flushWorkflowStatusBuffer();
    const retrievedHandle = operon.retrieveWorkflow<string>(workflowUUID);
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
