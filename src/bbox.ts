import 'source-map-support/register';
import 'reflect-metadata';

import * as Commander from 'commander';
import { difference } from 'lodash';
import * as jf from 'joiful';
import {PrettyJoi} from './pretty-joi';
import {WaitOnOptions} from 'wait-on';
import {ProcessList, ProcessManager} from './process-manager';
import {BboxDiscovery} from './bbox-discovery';

export type Cli = Commander.Command;

export interface RunnableFnParams {
  module: Module;
}

export type RunnableFn = (params: RunnableFnParams) => Promise<any>;
export type Runnable = string | RunnableFn;
export type RunnableSpec = Runnable | Runnable[];
export type DependencySpec = string;
export type EnvValuesSpec = {[key: string]: any};

export enum ServiceProcessStatus {
  Unknown = 'Unknown',
  Online = 'Online',
  Offline = 'Offline'
}

export interface SubServiceSpec {
  name: string;
  port?: number;
  containerPort?: number;
}

export interface ServiceSpec {
  name: string;
  port?: number;
  containerPort?: number;
  start?: string;
  subServices?: {
    [key: string]: SubServiceSpec
  }
  env: EnvValuesSpec,
  provideEnvValues?: {[key: string]: string},
  dependencies?: DependencySpec[],
  healthCheck?: {
    // https://www.npmjs.com/package/wait-on#nodejs-api-usage
    waitOn: WaitOnOptions
  },
  valueProviders?: {[key: string]: string}
  values?: {[key: string]: any}
}

export enum Runtime {
  Local = 'Local',
  Docker = 'Docker'
}

export interface ModuleState {
  ranMigrations: string[];
  ranAllMigrations: boolean;
  built: boolean;
}

export class ModuleSpec {
  name: string;
  docker?: {
    image?: string;
    file?: string;
    volumes?: {
      [key: string]: string
    }
  };
  services: {[key: string]: ServiceSpec};
  runtime?: Runtime;
  build?: RunnableSpec;
  migrations?: {[key: string]: RunnableSpec};
  env?: {[key: string]: any};
}

export interface BboxModule {
  onInit?(bbox: Bbox, ctx: Ctx): Promise<any>;
  onCliInit?(bbox: Bbox, cli: Cli, ctx: Ctx): Promise<any>;
  beforeStart?(bbox: Bbox, ctx: Ctx): Promise<any>;
  beforeStatus?(bbox: Bbox, ctx: Ctx): Promise<any>;
}

export interface ServiceState {
  processStatus: ServiceProcessStatus
}

export class Service {
  module: Module;
  name: string;
  spec: ServiceSpec;
  state: ServiceState;
}

export class Module {
  root: boolean;
  name: string;
  spec: ModuleSpec;
  bboxPath: string;
  bboxModule?: BboxModule;
  absolutePath: string;
  path: string;
  cwdAbsolutePath: string;
  availableRuntimes: Runtime[];
  runtime: Runtime;
  state: ModuleState;
  services: {[key: string]: Service};
}

export interface Ctx {
  projectOpts: ProjectOpts
  processList: ProcessList,
  stagedStates: {service?: {service: Service, state: Partial<ServiceState>}, module?: {module: Module, state: Partial<ModuleState>}}[];
}

export class ServiceCommandParams {
  @jf.array().required().items(joi => joi.string()).min(1).max(1)
  services: string[]
}

export class RunCommandParams {
  @jf.string().required()
  module: string;
  @jf.string().required()
  runnable: string;
}

export class ConfigureParams {
  @jf.string().allow('')
  todo?: string;
}

export class ShellParams {
  @jf.array().required().items(joi => joi.string()).min(1).max(1)
  services: string[]
}

export class ListCommandParams {
  @jf.string().allow('')
  mode?: string;
}

export function validateParams(params: {paramsType?: any} = {}) {
  return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const [methodParams, ctx] = Reflect.getMetadata('design:paramtypes', target, propertyKey);
    if (methodParams.name !== 'Object') {
      params.paramsType = methodParams;
    }

    const origMethod = descriptor.value;
    descriptor.value = function commandMethodParamsValidator() {
      //validate
      if (params.paramsType) {
        const val = jf.validateAsClass(arguments[0], params.paramsType);
        if (val.error) {
          //TODO types
          const error: any = val.error;
          //val.error.name = 'TypeError';
          const parsed = PrettyJoi.parseError(error);
          error.message = parsed.message;
          throw error;
        }
        arguments[0] = val.value;
      }

      return origMethod.apply(this, arguments);
    }
  }
}

export class ProjectOpts {
  rootPath: string;
  dockerComposePath: string;
}

export class Bbox {
  private modules: Module[];

  constructor(
    private fileManager: BboxDiscovery,
    private processManager: ProcessManager
  ) {
  }

  async init(ctx: Ctx) {
    this.modules = await this.loadAllModules(ctx);

    for (const module of this.modules) {
      if (module.bboxModule?.onInit) {
        await module.bboxModule.onInit(this, ctx);
      }
    }
  }

  async onCliInit(cli: Cli, ctx: Ctx) {
    for (const module of this.modules) {
      if (module.bboxModule?.onCliInit) {
        await module.bboxModule.onCliInit(this, cli, ctx);
      }
    }
  }

  @validateParams()
  async test(params: ServiceCommandParams, ctx: Ctx) {
    //const {module, service} = await this.getService(params.services[0]);
    //console.log(module, service); // XXX
    //await this.processManager.sendDataToService(module, service);
  }

  @validateParams()
  async configure(params: ConfigureParams, ctx: Ctx) {

  }

  async run(params: RunCommandParams, ctx: Ctx) {
    const module = await this.getModule(params.module, ctx);
    try {
      await this.runInteractive(module, params.runnable, ctx);
    } catch (e) {
      console.error(e); // XXX
      throw e;
    }
  }

  @validateParams()
  async shell(params: ShellParams, ctx: Ctx) {
    const module = await this.getModule(params.services[0], ctx);

    //TODO
  }

  @validateParams()
  async build(params: ServiceCommandParams, ctx: Ctx) {
    const module = await this.getModule(params.services[0], ctx);

    await this.stageBuild(module, ctx);
    await this.executeStaged(ctx);
  }

  @validateParams()
  async start(params: ServiceCommandParams, ctx: Ctx) {
    const {service} = await this.getService(params.services[0], ctx);

    await this.stageStartDependenciesIfNeeded(service, ctx);

    await this.stageStart(service, ctx);

    await this.executeStaged(ctx);
  }

  @validateParams()
  async stop(params: ServiceCommandParams, ctx: Ctx) {
    const {service} = await this.getService(params.services[0], ctx);

    this.stageServiceState(service, {processStatus: ServiceProcessStatus.Offline}, ctx);

    await this.executeStaged(ctx);
  }

  @validateParams()
  async migrate(params: ServiceCommandParams, ctx: Ctx) {
    const module = await this.getModule(params.services[0], ctx);
    await this.stageMigrationsIfNeeded(module, ctx);
    await this.executeStaged(ctx);
  }

  @validateParams()
  async value(params: ServiceCommandParams, ctx: Ctx) {
    const ret = await this.provideValue(params.services[0], ctx);
    console.log(ret); // XXX
  }

  private async executeStaged(ctx: Ctx) {
    for (const moduleOrService of ctx.stagedStates) {
      // TODO detect module or service
      if (moduleOrService.module) {
        const {module, state} = moduleOrService.module;
        console.log(`Service ${module.name}: Applying state`, state); // XXX
        if (typeof state.built !== 'undefined') {
          if (state.built && !module.state.built) {
            await this.runBuild(module, ctx);
          }
        }
        if (typeof state.ranAllMigrations !== 'undefined') {
          await this.runMigrate(module, ctx);
        }
      }

      if (moduleOrService.service) {
        const {service, state} = moduleOrService.service;
        console.log(`Service ${service.name}: Applying state`, state); // XXX
        if (typeof state.processStatus !== 'undefined') {
          switch (state.processStatus) {
            case ServiceProcessStatus.Online:
              await this.processManager.startAndWait(service, ctx);
              break;
            case ServiceProcessStatus.Offline:
              await this.processManager.stopAndWait(service, ctx);
              break;
            default:
              throw new Error(`Unhandled ServiceProcessStatus ${state.processStatus}`);
          }
        }
      }

    }
  }

  async provideValue(valueName, ctx) {
    try {
      const [serviceName, providerName] = valueName.split('.');
      const {module, service} = await this.getService(serviceName, ctx);
      const serviceSpec = service.spec;

      if (serviceSpec.values && serviceSpec.values[providerName]) {
        return serviceSpec.values[providerName];
      }

      if (!serviceSpec.valueProviders || !serviceSpec.valueProviders[providerName]) {
        throw new Error(`Value provider ${providerName} not found`);
      }

      await this.stageBuildIfNeeded(module, ctx);
      await this.executeStaged(ctx);

      return await this.processManager.run(module, serviceSpec.valueProviders[providerName], serviceSpec.env, ctx);
    } catch (e) {
      throw Error(`Could not get ${valueName} value: ${e.message}`);
    }
  }

  @validateParams()
  async list(params: ListCommandParams, ctx: Ctx) {
    const modules = await this.getAllModules(ctx);
    for (const module of modules) {
      for (const service of Object.values(module.services)) {
        const process = await this.processManager.findServiceProcess(service, ctx);
        console.log(`${service.name} [${module.name}]: ${process?.status ?? 'Unknown'}, built: ${module.state.built}, pending migrations: ${this.getNotAppliedMigrations(module).join(', ')}, runtimes: ${module.availableRuntimes}`); // XXX
      }
    }
  }

  async shutdown() {
    await this.processManager.onShutdown();
  }

  private async stageStart(service: Service, ctx: Ctx) {
    // if (service.spec.provideEnvValues) {
    //   const envValues = await this.provideValues(service.spec.provideEnvValues, ctx);
    //   Object.assign(service.spec.env, envValues);
    // }

    await this.stageBuildIfNeeded(service.module, ctx);
    await this.stageMigrationsIfNeeded(service.module, ctx);

    this.stageServiceState(service, {processStatus: ServiceProcessStatus.Online}, ctx);
  }

  async stageStartDependenciesIfNeeded(service: Service, ctx: Ctx) {
    const serviceSpec = service.spec;
    if (!serviceSpec.dependencies) {
      return;
    }

    for (const serviceDependencyName of serviceSpec.dependencies) {
      const {service} = await this.getService(serviceDependencyName, ctx);
      await this.stageStartDependenciesIfNeeded(service, ctx);
      await this.stageStart(service, ctx);
    }
  }

  async getModule(name: string, ctx: Ctx) {
    const modules = await this.getAllModules(ctx);
    const module = modules.find((module) => module.name === name);
    if (!module) {
      throw new Error(`Module "${name}" not found. All discovered modules: ${modules.map(m => m.name).join(', ')}`);
    }
    return module;
  }

  async getService(serviceName: string, ctx: Ctx) {
    const modules = await this.getAllModules(ctx);
    for (const module of modules) {
      const service = Object.values(module.services).find(service => service.name === serviceName);
      if (service) {
        return {
          module,
          service
        };
      }
    }

    throw new Error(`Service "${serviceName}" not found.`);
  }

  async getAllModules(ctx: Ctx) {
    if (!this.modules) {
      throw new Error('Modules not initialized');
    }
    return this.modules;
  }

  async loadAllModules(ctx: Ctx) {
    const internalModules = await this.fileManager.discoverInternalModules(ctx.projectOpts.rootPath);
    const modules = await this.fileManager.discoverModules(ctx.projectOpts.rootPath);
    modules.push(...internalModules);
    return modules;
  }

  async provideValues(values: {[key: string]: string}, ctx) {
    const ret = {};
    for (const envName in values) {
      ret[envName] = await this.provideValue(values[envName], ctx);
    }
    return ret;
  }

  private async stageBuild(module: Module, ctx: Ctx) {
    module.state.built = false;
    this.stageModuleState(module, {built: true}, ctx);
  }

  private stageServiceState(service: Service, state: Partial<ServiceState>, ctx: Ctx) {
    ctx.stagedStates.push({service: {service, state}});
  }

  private stageModuleState(module: Module, state: Partial<ModuleState>, ctx: Ctx) {
    ctx.stagedStates.push({module: {module, state}});
  }

  private async runBuild(module: Module, ctx: Ctx) {
    if (!module.spec.build) {
      throw new Error('Module has not build action specified');
    }

    await this.runInteractive(module, module.spec.build, ctx);

    module.state.built = true;
    this.fileManager.saveState(module);
  }

  private async runMigrate(module: Module, ctx: Ctx): Promise<{state?: Partial<ModuleState>}> {
    if (!module.spec.migrations) {
      throw new Error('Module has migrations specified');
    }

    const diff = this.getNotAppliedMigrations(module);
    if (diff.length === 0) {
      console.log('> No new migrations'); // XXX
      return;
    }

    for (const migId of diff) {
      try {
        console.log(`> Migrating ${migId}`); // XXX
        await this.runInteractive(module, module.spec.migrations[migId], ctx);

        module.state.ranMigrations.push(migId);
        this.fileManager.saveState(module);
      } catch (e) {
        console.log(`> Migration ${migId} failed.`); // XXX
        throw e;
      }
    }

    module.state.ranAllMigrations = true;
    this.fileManager.saveState(module);

    console.log(`> All new migrations applied.`); // XXX

    return {};
  }

  private async runInteractive(module: Module, runnable: RunnableSpec, ctx: Ctx) {
    if (Array.isArray(runnable)) {
      for (const run of runnable) {
        await this.runInteractive(module, run, ctx);
      }
      return;
    }

    if (typeof runnable === 'function') {
      await runnable({
        module: module
      });
      return;
    }

    await this.processManager.runInteractive(module, runnable, {}, ctx);
  }

  private async stageBuildIfNeeded(module: Module, ctx: Ctx) {
    if (module.state.built || !module.spec.build) {
      return;
    }

    this.stageModuleState(module, {built: true}, ctx);
  }

  private async stageMigrationsIfNeeded(module: Module, ctx: Ctx) {
    const migrations = this.getNotAppliedMigrations(module);
    if (migrations.length === 0) {
      return;
    }

    this.stageModuleState(module, {ranAllMigrations: true}, ctx);
  }

  private getNotAppliedMigrations(module: Module) {
    if (!module.spec.migrations) {
      return [];
    }

    const migrationIds = Object.keys(module.spec.migrations).sort();
    const diff = difference(migrationIds, module.state.ranMigrations);
    return diff;
  }
}

