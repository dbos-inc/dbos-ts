#!/usr/bin/env node

import { dbosConfigFilePath, parseConfigFile } from "./config";
import { DBOSRuntime, DBOSRuntimeConfig } from "./runtime";
import { Command } from 'commander';
import { DBOSConfig } from "../dbos-executor";
import { init } from "./init";
import { generateOpenApi } from "../staticAnalysis/openApi";
import YAML from 'yaml';
import fs from 'node:fs/promises';
import path from 'node:path';
import { debugWorkflow } from "./debug";

const program = new Command();

////////////////////////
/* LOCAL DEVELOPMENT  */
////////////////////////

export interface DBOSCLIStartOptions {
  port?: number,
  loglevel?: string,
  configfile?: string,
  entrypoint?: string,
}

interface DBOSDebugOptions extends DBOSCLIStartOptions {
  proxy: string, // TODO: in the future, we provide the proxy URL
  uuid: string, // Workflow UUID
}

program
  .command("openapi")
  .argument('<entrypoint>', 'Specify the entrypoint file path')
  .action(async (entrypoint: string) => {
    const openapi = await generateOpenApi(entrypoint);
    if (openapi) {
      const filename = path.join(path.dirname(entrypoint), "openapi.yaml");
      const yaml = `# OpenApi specification generated for application\n\n` + YAML.stringify(openapi, { aliasDuplicateObjects: false });
      await fs.writeFile(filename, yaml, { encoding: 'utf-8' });
    }
  });

program
  .command('start')
  .description('Start the server')
  .option('-p, --port <number>', 'Specify the port number')
  .option('-l, --loglevel <string>', 'Specify log level')
  .option('-c, --configfile <string>', 'Specify the config file path', dbosConfigFilePath)
  .option('-e, --entrypoint <string>', 'Specify the entrypoint file path')
  .action(async (options: DBOSCLIStartOptions) => {
    const [dbosConfig, runtimeConfig]: [DBOSConfig, DBOSRuntimeConfig] = parseConfigFile(options);
    const runtime = new DBOSRuntime(dbosConfig, runtimeConfig);
    await runtime.init();
    runtime.startServer();
  });

program
  .command('debug')
  .description('Debug a workflow')
  .requiredOption('-x, --proxy <string>', 'Specify the debugger proxy URL')
  .requiredOption('-u, --uuid <string>', 'Specify the workflow UUID to debug')
  .option('-l, --loglevel <string>', 'Specify log level')
  .option('-c, --configfile <string>', 'Specify the config file path', dbosConfigFilePath)
  .option('-e, --entrypoint <string>', 'Specify the entrypoint file path')
  .action(async (options: DBOSDebugOptions) => {
    const [dbosConfig, runtimeConfig]: [DBOSConfig, DBOSRuntimeConfig] = parseConfigFile(options);
    await debugWorkflow(dbosConfig, runtimeConfig, options.proxy, options.uuid);
  });

program
  .command('init')
  .description('Init a DBOS application')
  .option('-n, --appName <application-name>', 'Application name', 'dbos-hello-app')
  .action(async (options: { appName: string }) => {
    await init(options.appName);
  });

program.parse(process.argv);

// If no arguments provided, display help by default
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
