import path from 'node:path';
import tsm from 'ts-morph';
import { Liquid } from "liquidjs";
import type { TransactionConfig } from './utility.js';
import { invoke } from 'lodash';

const __dirname = import.meta.dirname;
const engine = new Liquid({
  root: path.resolve(__dirname, '..', 'templates'),
  extname: ".liquid"
});

async function render(file: string, ctx?: object): Promise<string> {
  return await engine.renderFile(file, ctx) as string;
}

function mapType(type: tsm.Type) {
  if (type.isString()) { return "TEXT"; }
  if (type.isNumber()) { return "INT"; }
  if (type.isBoolean()) { return "BOOLEAN"; }
  // TODO: support more types

  throw new Error(`Unsupported type: ${type.getText()}`);
}

export async function generateCreate(append: (sql: string) => Promise<void>, project: tsm.Project, methods: (readonly [tsm.MethodDeclaration, TransactionConfig])[], appVersion?: string) {
  const dbosSql = await generateDbosCreate(appVersion);
  await append(dbosSql);

  for (const sourceFile of project.getSourceFiles()) {
    const moduleSql = await generateModuleCreate(sourceFile, appVersion);
    append(moduleSql);
  }

  for (const [method, config] of methods) {
    const methodSql = await generateMethodCreate(method, config, appVersion);
    append(methodSql);
  }
}

export async function generateDrop(append: (sql: string) => Promise<void>, project: tsm.Project, methods: (readonly [tsm.MethodDeclaration, TransactionConfig])[], appVersion?: string) {
  const dbosSql = await generateDbosDrop(appVersion);
  await append(dbosSql);

  for (const sourceFile of project.getSourceFiles()) {
    const moduleSql = await generateModuleDrop(sourceFile, appVersion);
    await append(moduleSql);
  }

  for (const [method, config] of methods) {
    const methodSql = await generateMethodDrop(method, config, appVersion);
    await append(methodSql);
  }
}

async function generateDbosCreate(appVersion: string | undefined) {
  const context = { appVersion };
  return await render("dbos.create.liquid", context);
}

async function generateDbosDrop(appVersion: string | undefined) {
  const context = { appVersion };
  return await render("dbos.drop.liquid", context);
}

function getMethodContext(method: tsm.MethodDeclaration, config: TransactionConfig, appVersion: string | undefined) {
  const methodName = method.getName();
  const className = method.getParentIfKindOrThrow(tsm.SyntaxKind.ClassDeclaration).getName();
  const moduleName = method.getSourceFile().getBaseNameWithoutExtension();
  const parameters = method.getParameters().slice(1).map(p => ({ name: p.getName(), type: mapType(p.getType()) }));

  const context = { ...config, methodName, className, moduleName, parameters, appVersion };
  return context;
}

async function generateMethodCreate(method: tsm.MethodDeclaration, config: TransactionConfig, appVersion: string | undefined) {
  const context = getMethodContext(method, config, appVersion);
  return await render("method.create.liquid", context);
}


async function generateMethodDrop(method: tsm.MethodDeclaration, config: TransactionConfig, appVersion: string | undefined) {
  const context = getMethodContext(method, config, appVersion);
  return await render("method.drop.liquid", context);
}

function getModuleContext(sourceFile: tsm.SourceFile, appVersion: string | undefined) {
  const results = sourceFile.getEmitOutput();
  const contents = results.getEmitSkipped() ? "" : results.getOutputFiles().map(f => f.getText()).join("\n");
  const moduleName = sourceFile.getBaseNameWithoutExtension();

  const context = { moduleName, contents, appVersion };
  return context;
}

async function generateModuleCreate(sourceFile: tsm.SourceFile, appVersion: string | undefined) {
  const context = getModuleContext(sourceFile, appVersion);
  return await render("module.create.liquid", context);
}

async function generateModuleDrop(sourceFile: tsm.SourceFile, appVersion: string | undefined) {
  const context = getModuleContext(sourceFile, appVersion);
  return await render("module.drop.liquid", context);
}