export class OperonError extends Error {
  // TODO: define a better coding system.
  constructor(msg: string, readonly operonErrorCode: number = 1) {
    super(msg);
  }
}

const WorkflowPermissionDeniedError = 2;
export class OperonWorkflowPermissionDeniedError extends OperonError {
  constructor(runAs: string, workflowName: string) {
    const msg = `Subject ${runAs} does not have permission to run workflow ${workflowName})`;
    super(msg, WorkflowPermissionDeniedError);
  }
}

const InitializationError = 3;
export class OperonInitializationError extends OperonError {
  constructor(msg: string) {
    super(msg, InitializationError);
  }
}

const ConflictingUUIDError = 5;
export class OperonWorkflowConflictUUIDError extends OperonError {
  constructor() {
    super("Conflicting UUIDs", ConflictingUUIDError);
  }
}
