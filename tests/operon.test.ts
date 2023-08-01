import {
  Operon,
  OperonConfig,
  OperonWorkflowPermissionDeniedError,
  WorkflowContext,
  WorkflowConfig,
  TransactionContext,
  CommunicatorContext,
  WorkflowParams
} from "src/";
import {
  generateOperonTestConfig,
  teardownOperonTestDb,
} from './helpers';
import { v1 as uuidv1 } from 'uuid';
import axios, { AxiosResponse } from 'axios';
import { sleep, TestKvTable } from "./helper";

describe('operon-tests', () => {
  let operon: Operon;
  let username: string;
  let config: OperonConfig;

  beforeAll(() => {
    config = generateOperonTestConfig();
    username = config.poolConfig.user || "postgres";
  });

  afterAll(async () => {
    await teardownOperonTestDb(config);
  });

  beforeEach(async () => {
    operon = new Operon(config);
    await operon.init();
    await operon.pool.query("DROP TABLE IF EXISTS OperonKv;");
    await operon.pool.query("CREATE TABLE IF NOT EXISTS OperonKv (id SERIAL PRIMARY KEY, value TEXT);");
  });

  afterEach(async () => {
    await operon.destroy();
  });

  test('simple-function', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows } = await txnCtxt.client.query(`select current_user from current_user where current_user=$1;`, [name]);
      return JSON.stringify(rows[0]);
    };
    operon.registerTransaction(testFunction, {readOnly: true});

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: string = await workflowCtxt.transaction(testFunction, name);
      return funcResult;
    };

    const testWorkflowConfig: WorkflowConfig = {
      rolesThatCanRun: ["operonAppAdmin", "operonAppUser"],
    }
    operon.registerWorkflow(testWorkflow, testWorkflowConfig);

    const params: WorkflowParams = {
      runAs: "operonAppAdmin",
    }
    const workflowResult: string = await operon.workflow(testWorkflow, params, username).getResult();

    expect(JSON.parse(workflowResult)).toEqual({"current_user": username});
  });

  test('simple-function-permission-denied', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows } = await txnCtxt.client.query(`select current_user from current_user where current_user=$1;`, [name]);
      return JSON.stringify(rows[0]);
    };
    operon.registerTransaction(testFunction);

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: string = await workflowCtxt.transaction(testFunction, name);
      return funcResult;
    };
    // Register the workflow as runnable only by admin
    const testWorkflowConfig: WorkflowConfig = {
      rolesThatCanRun: ["operonAppAdmin"],
    }
    operon.registerWorkflow(testWorkflow, testWorkflowConfig);

    const params: WorkflowParams = {
      runAs: "operonAppUser",
    }
    await expect(operon.workflow(testWorkflow, params, username).getResult()).rejects.toThrow(
      OperonWorkflowPermissionDeniedError
    );
  });

  test('simple-function-default-user-permission-denied', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows } = await txnCtxt.client.query(`select current_user from current_user where current_user=$1;`, [name]);
      return JSON.stringify(rows[0]);
    };
    operon.registerTransaction(testFunction);

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: string = await workflowCtxt.transaction(testFunction, name);
      return funcResult;
    };

    const testWorkflowConfig: WorkflowConfig = {
      rolesThatCanRun: ["operonAppAdmin", "operonAppUser"],
    }
    operon.registerWorkflow(testWorkflow, testWorkflowConfig);

    const hasPermissionSpy = jest.spyOn(operon, 'hasPermission');
    await expect(operon.workflow(testWorkflow, {}, username).getResult()).rejects.toThrow(
      OperonWorkflowPermissionDeniedError
    );
    expect(hasPermissionSpy).toHaveBeenCalledWith(
      "defaultRole",
      testWorkflowConfig
    );
  });

  test('return-void', async() => {
    const testFunction = async (txnCtxt: TransactionContext) => {
      void txnCtxt;
      await sleep(10);
      return;
    };
    operon.registerTransaction(testFunction);
    const workflowUUID = uuidv1();
    await operon.transaction(testFunction, {workflowUUID: workflowUUID});
    await operon.transaction(testFunction, {workflowUUID: workflowUUID});
    await operon.transaction(testFunction, {workflowUUID: workflowUUID});
  });

  test('tight-loop', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows }= await txnCtxt.client.query(`select current_user from current_user where current_user=$1;`, [name]);
      return JSON.stringify(rows[0]);
    };
    operon.registerTransaction(testFunction);

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: string = await workflowCtxt.transaction(testFunction, name);
      return funcResult;
    };
    operon.registerWorkflow(testWorkflow);

    for (let i = 0; i < 100; i++) {
      const workflowResult: string = await operon.workflow(testWorkflow, {}, username).getResult();
      expect(JSON.parse(workflowResult)).toEqual({"current_user": username});
    }
  });
  

  test('abort-function', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows }= await txnCtxt.client.query<TestKvTable>("INSERT INTO OperonKv(value) VALUES ($1) RETURNING id", [name]);
      if (name === "fail") {
        await txnCtxt.rollback();
      }
      return Number(rows[0].id);
    };
    operon.registerTransaction(testFunction);

    const testFunctionRead = async (txnCtxt: TransactionContext, id: number) => {
      const { rows }= await txnCtxt.client.query<TestKvTable>("SELECT id FROM OperonKv WHERE id=$1", [id]);
      if (rows.length > 0) {
        return Number(rows[0].id);
      } else {
        // Cannot find, return a negative number.
        return -1;
      }
    };
    operon.registerTransaction(testFunctionRead);

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: number = await workflowCtxt.transaction(testFunction, name);
      const checkResult: number = await workflowCtxt.transaction(testFunctionRead, funcResult);
      return checkResult;
    };
    operon.registerWorkflow(testWorkflow);

    for (let i = 0; i < 10; i++) {
      const workflowResult: number = await operon.workflow(testWorkflow, {}, username).getResult();
      expect(workflowResult).toEqual(i + 1);
    }
    
    // Should not appear in the database.
    const workflowResult: number = await operon.workflow(testWorkflow, {}, "fail").getResult();
    expect(workflowResult).toEqual(-1);
  });

  test('multiple-aborts', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows }= await txnCtxt.client.query<TestKvTable>("INSERT INTO OperonKv(value) VALUES ($1) RETURNING id", [name]);
      if (name !== "fail") {
        // Recursively call itself so we have multiple rollbacks.
        await testFunction(txnCtxt, "fail");
      }
      await txnCtxt.rollback();
      return Number(rows[0].id);
    };
    operon.registerTransaction(testFunction);

    const testFunctionRead = async (txnCtxt: TransactionContext, id: number) => {
      const { rows }= await txnCtxt.client.query<TestKvTable>("SELECT id FROM OperonKv WHERE id=$1", [id]);
      if (rows.length > 0) {
        return Number(rows[0].id);
      } else {
        // Cannot find, return a negative number.
        return -1;
      }
    };
    operon.registerTransaction(testFunctionRead);

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: number = await workflowCtxt.transaction(testFunction, name);
      const checkResult: number = await workflowCtxt.transaction(testFunctionRead, funcResult);
      return checkResult;
    };
    operon.registerWorkflow(testWorkflow);

    // Should not appear in the database.
    const workflowResult: number = await operon.workflow(testWorkflow, {}, "test").getResult();
    expect(workflowResult).toEqual(-1);
  });


  test('oaoo-simple', async() => {
    const testFunction = async (txnCtxt: TransactionContext, name: string) => {
      const { rows }= await txnCtxt.client.query<TestKvTable>("INSERT INTO OperonKv(value) VALUES ($1) RETURNING id", [name]);
      if (name === "fail") {
        await txnCtxt.rollback();
      }
      return Number(rows[0].id);
    };
    operon.registerTransaction(testFunction);

    const testFunctionRead = async (txnCtxt: TransactionContext, id: number) => {
      const { rows }= await txnCtxt.client.query<TestKvTable>("SELECT id FROM OperonKv WHERE id=$1", [id]);
      if (rows.length > 0) {
        return Number(rows[0].id);
      } else {
        // Cannot find, return a negative number.
        return -1;
      }
    };
    operon.registerTransaction(testFunctionRead);

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult: number = await workflowCtxt.transaction(testFunction, name);
      const checkResult: number = await workflowCtxt.transaction(testFunctionRead, funcResult);
      return checkResult;
    };
    operon.registerWorkflow(testWorkflow);

    let workflowResult: number;
    const uuidArray: string[] = [];
    for (let i = 0; i < 10; i++) {
      const workflowUUID: string = uuidv1();
      uuidArray.push(workflowUUID);
      workflowResult = await operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, username).getResult();
      expect(workflowResult).toEqual(i + 1);
    }
    // Should not appear in the database.
    const failUUID: string = uuidv1();
    workflowResult = await operon.workflow(testWorkflow, {workflowUUID: failUUID}, "fail").getResult();
    expect(workflowResult).toEqual(-1);

    // Rerunning with the same workflow UUID should return the same output.
    for (let i = 0; i < 10; i++) {
      const workflowUUID: string = uuidArray[i];
      const workflowResult: number = await operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, username).getResult();
      expect(workflowResult).toEqual(i + 1);
    }
    // Given the same workflow UUID but different input, should return the original execution.
    workflowResult = await operon.workflow(testWorkflow, {workflowUUID: failUUID}, "hello").getResult();
    expect(workflowResult).toEqual(-1);
  });


  test('simple-communicator', async() => {
    const testCommunicator = async (commCtxt: CommunicatorContext, name: string) => {
      const response1 = await axios.post<AxiosResponse>('https://postman-echo.com/post', {"name": name});
      const response2 = await axios.post<AxiosResponse>('https://postman-echo.com/post', response1.data.data);
      return JSON.stringify(response2.data);
    };
    operon.registerCommunicator(testCommunicator);

    const testWorkflow = async (workflowCtxt: WorkflowContext, name: string) => {
      const funcResult = await workflowCtxt.external(testCommunicator, name);
      return funcResult ?? "error";
    };
    operon.registerWorkflow(testWorkflow);

    const workflowUUID: string = uuidv1();

    let result: string = await operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, 'qianl15').getResult();
    expect(JSON.parse(result)).toMatchObject({data: { "name" : "qianl15"}});

    // Test OAOO. Should return the original result.
    result = await operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, 'peter').getResult();
    expect(JSON.parse(result)).toMatchObject({data: { "name" : "qianl15"}});
  });

  test('simple-workflow-notifications', async() => {
    const receiveWorkflow = async(ctxt: WorkflowContext) => {
      const test = await ctxt.recv("test", 2) as number;
      const fail = await ctxt.recv("fail", 0) ;
      return test === 0 && fail === null;
    }
    operon.registerWorkflow(receiveWorkflow);

    const sendWorkflow = async(ctxt: WorkflowContext) => {
      return await ctxt.send("test", 0);
    }
    operon.registerWorkflow(sendWorkflow);

    const workflowUUID = uuidv1();
    const promise = operon.workflow(receiveWorkflow, {workflowUUID: workflowUUID}).getResult();
    const send = await operon.workflow(sendWorkflow, {}).getResult();
    expect(send).toBe(true);
    expect(await promise).toBe(true);
    const retry = await operon.workflow(receiveWorkflow, {workflowUUID: workflowUUID}).getResult();
    expect(retry).toBe(true);
  });

  test('simple-operon-notifications', async() => {
    // Send and have a receiver waiting.
    const promise = operon.recv({}, "test", 2);
    const send = await operon.send({}, "test", 123);
    expect(send).toBe(true);
    expect(await promise).toBe(123);

    // Send and then receive.
    await expect(operon.send({}, "test2", 456)).resolves.toBe(true);
    await sleep(10);
    await expect(operon.recv({}, "test2", 1)).resolves.toBe(456);
  });

  test('notification-oaoo',async () => {
    const sendWorkflowUUID = uuidv1();
    const recvWorkflowUUID = uuidv1();
    const promise = operon.recv({workflowUUID: recvWorkflowUUID}, "test", 1);
    const send = await operon.send({workflowUUID: sendWorkflowUUID}, "test", 123);
    expect(send).toBe(true);

    expect(await promise).toBe(123);

    // Send again with the same UUID but different input.
    // Even we sent it twice, it should still be 123.
    await expect(operon.send({workflowUUID: sendWorkflowUUID}, "test", 123)).resolves.toBe(true);

    await expect(operon.recv({workflowUUID: recvWorkflowUUID}, "test", 1)).resolves.toBe(123);

    // Receive again with the same workflowUUID, should get the same result.
    await expect(operon.recv({workflowUUID: recvWorkflowUUID}, "test", 1)).resolves.toBe(123);

    // Receive again with the different workflowUUID.
    await expect(operon.recv({}, "test", 2)).resolves.toBeNull();
  });

  test('endtoend-oaoo', async () => {
    const remoteState = {
      num: 0
    }
  
    const testFunction = async (txnCtxt: TransactionContext, code: number) => {
      void txnCtxt;
      await sleep(1);
      return code + 1;
    };
  
    const testWorkflow = async (workflowCtxt: WorkflowContext, code: number) => {
      const funcResult: number = await workflowCtxt.transaction(testFunction, code);
      remoteState.num += 1;
      return funcResult;
    };
    operon.registerTransaction(testFunction, {readOnly: true});
    operon.registerWorkflow(testWorkflow);
  
    const workflowUUID = uuidv1();
    await expect(operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, 10).getResult()).resolves.toBe(11);
    expect(remoteState.num).toBe(1);
  
    await operon.flushWorkflowOutputBuffer();
    // Run it again with the same UUID, should get the same output.
    await expect(operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, 10).getResult()).resolves.toBe(11);
    // The workflow should not run at all.
    expect(remoteState.num).toBe(1);
  });

  test('readonly-recording', async() => {
    const remoteState = {
      num: 0,
      workflowCnt: 0
    };

    const readFunction = async (txnCtxt: TransactionContext, id: number) => {
      const { rows } = await txnCtxt.client.query<TestKvTable>(`SELECT value FROM OperonKv WHERE id=$1`, [id]);
      remoteState.num += 1;
      if (rows.length === 0) {
        return null;
      }
      return rows[0].value;
    };
    operon.registerTransaction(readFunction, {readOnly: true});

    const writeFunction = async (txnCtxt: TransactionContext, id: number, name: string) => {
      const { rows } = await txnCtxt.client.query<TestKvTable>(`INSERT INTO OperonKv VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value RETURNING value;`, [id, name]);
      return rows[0].value;
    };
    operon.registerTransaction(writeFunction, {});

    const testWorkflow = async (workflowCtxt: WorkflowContext, id: number, name: string) => {
      await workflowCtxt.transaction(readFunction, id);
      remoteState.workflowCnt += 1;
      await workflowCtxt.transaction(writeFunction, id, name);
      remoteState.workflowCnt += 1; // Make sure the workflow actually runs.
      throw Error("dumb test error");
    };
    operon.registerWorkflow(testWorkflow, {});

    const workflowUUID = uuidv1();

    // Invoke the workflow, should get the error.
    await expect(operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, 123, "test").getResult()).rejects.toThrowError(new Error("dumb test error"));
    expect(remoteState.num).toBe(1);
    expect(remoteState.workflowCnt).toBe(2);

    // Invoke it again, there should be no output recorded and throw the same error.
    await expect(operon.workflow(testWorkflow, {workflowUUID: workflowUUID}, 123, "test").getResult()).rejects.toThrowError(new Error("dumb test error"));
    expect(remoteState.num).toBe(1);
    expect(remoteState.workflowCnt).toBe(4);
  });
});

