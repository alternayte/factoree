import { TestWorkflowEnvironment } from "@temporalio/testing";

export const startTemporal = async (): Promise<{
  environment: TestWorkflowEnvironment;
  stop: () => Promise<void>;
}> => {
  const environment = await TestWorkflowEnvironment.createLocal();
  return { environment, stop: () => environment.teardown() };
};
