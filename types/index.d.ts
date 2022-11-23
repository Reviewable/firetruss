declare class Truss {
  static readonly SERVER_TIMESTAMP: any;
  static readonly VERSION: string;
  static readonly FIREBASE_SDK_VERSION: string;
  readonly SERVER_TIMESTAMP: any;
  readonly VERSION: string;
  readonly FIREBASE_SDK_VERSION: string;

  static readonly ComponentPlugin: {install(vue: any, {truss: Truss}): void;};

  static readonly computedPropertyStats: Stats;
  static readonly worker: WorkerFunctions;
  static connectWorker(worker: string | Worker | SharedWorker, config: any): Promise<void>;
  static preExpose(functionName: string): void;
  static bounceConnection(): Promise<void>;
  static suspend(): Promise<void>;
  static debugPermissionDeniedErrors(
    simulatedTokenGenerator: any, maxSimulationDuration: number, callFilter: any
  ): Promise<void>;
  static debounceAngularDigest(wait: number): void;
  static escapeKey(key: string): string;
  static unescapeKey(escapedKey: string): string;
  static enableLogging(fn: boolean | ((msg: string) => void)): void;

  readonly now: number;
  readonly info: Info;
  readonly store: Truss.Model;

  constructor(rootUrl: string);

  mount(classes: ModelConstructor[] | Record<string, ModelConstructor>): void;
  destroy(): void;
  newKey(): string;
  nextTick(): Promise<void>;
  throttleRemoteDataUpdates(delay: number): void;
  checkObjectsForRogueProperties(): void;
  authenticate(token?: string): Promise<void>;
  unauthenticate(): Promise<void>;

  intercept(actionType: InterceptActionKey, callbacks: InterceptCallbacks): () => void;

  connect(
    connections: Truss.Query | Truss.Reference | Connections | (() => Connections | undefined)
  ): Truss.Connector;
  connect(scope: any, connections: Connections | (() => Connections | undefined)): Truss.Connector;

  peek(
    target: Truss.Query | Truss.Reference | Connections,
    callback?: (value: any) => Promise<any> | void
  ): Promise<any>;

  observe(subject: () => any, callback: (newValue: any, oldValue: any) => void, options?: {
    precise?: boolean, deep?: boolean, scope?: any
  }): () => void;

  when(expression: () => any, options?: {timeout?: number, scope?: any}): Promise<any>;
}

declare namespace Truss {
  class Model extends BaseModel {
    readonly $parent: Model | undefined;
    readonly $path: string;
    readonly $ref: Reference;
    readonly $refs: Reference;
    readonly $key: string;
    readonly $data: Record<string, Node>;
    readonly $hidden: boolean;
    readonly $empty: boolean;
    readonly $keys: string[];
    readonly $values: string[];
    readonly $ready: boolean;
    readonly $overridden: boolean;

    $nextTick(): Promise<void>;
    $freezeComputedProperty(): void;

    $set(value: any): Promise<void>;
    $update(values: Record<string, any>): Promise<void>;
    $override(values: Record<string, any>): Promise<void>;
    $commit(updateFunction: (txn: Transaction) => void): Promise<Transaction>;

    // This should have a value type of Node, but there appears to be no way to specify an indexed
    // property solely as a fallback (with a type other than any or unknown), so it ends up clashing
    // with all the other properties instead.
    [key: string]: any;
  }

  interface Connector {
    readonly ready: boolean;
    readonly at: Connections;
    readonly data: Record<string, any>;
    destroy(): void;
  }

  interface Query extends Handle {
    readonly constraints: QuerySpec;
    annotate(annotations: any): Query;
  }

  interface Reference extends Handle {
    readonly value: any;
    annotate(annotations: any): Reference;
    query(spec: QuerySpec): Query;
    set(value: any): Promise<void>;
    update(values: Record<string, any>): Promise<void>;
    override(value: any): Promise<void>;
    commit(updateFunction: (txn: Transaction) => void): Promise<Transaction>;
  }

  interface Operation {
    readonly type: 'read' | 'write' | ' auth';
    readonly method:
    'set' | 'update' | 'commit' | 'peek' | 'authenticate' | 'unauthenticate' | 'certify';
    readonly target: Reference;
    readonly targets: Reference[];
    readonly operand: any;
    readonly ready: boolean;
    readonly running: boolean;
    readonly ended: boolean;
    readonly tries: number;
    readonly error: Error | undefined;

    onSlow(delay: number, callback: (op: Operation) => void);
  }

}

export default Truss;

type Node = undefined | boolean | number | string | Truss.Model;

interface ModelConstructor {
  new(): Truss.Model;
}

declare class BaseModel {
  readonly $truss: Truss;
  readonly $info: Info;
  readonly $store: Truss.Model;
  readonly $now: number;
  readonly $newKey: string;
  readonly $destroyed: boolean;

  $intercept(actionType: InterceptActionKey, callbacks: InterceptCallbacks): () => void;
  $connect(
    connections: Truss.Query | Truss.Reference | Connections | (() => Connections | undefined)
  ): Truss.Connector;
  $connect(scope: any, connections: Connections | (() => Connections | undefined)): Truss.Connector;
  $peek(
    target: Truss.Query | Truss.Reference | Connections,
    callback?: (value: any) => Promise<any> | void
  ): Promise<any>;
  $observe(subject: () => any, callback: (newValue: any, oldValue: any) => void, options?: {
    precise?: boolean, deep?: boolean, scope?: any
  }): () => void;
  $when(expression: () => any, options?: {timeout?: number, scope?: any}): Promise<any>;
}

interface Handle {
  readonly $ref: Truss.Reference;
  readonly ready: boolean;
  readonly key: string;
  readonly path: string;
  readonly parent: Truss.Reference;
  readonly annotations: Record<string, any>;
  child(...segments: string[]): Truss.Reference | undefined;
  children(...segments: string[]): References;
  peek(callback?: (value: any) => Promise<any> | void): Promise<any>;
  match(pattern: string): Record<string, string> | undefined;
  test(pattern: string): boolean;
  isEqual(other: Truss.Reference | Truss.Query): boolean;
  belongsTo(truss: Truss): boolean;
}

type References = Truss.Reference | ReferencesObject | undefined;
interface ReferencesObject {
  [key: string]: References;
}

interface QuerySpec {
  readonly by: '$key' | '$value' | Truss.Reference;
  readonly at?: any;
  readonly from?: any;
  readonly to?: any;
  readonly first?: number;
  readonly last?: number;
}

interface Transaction {
  readonly currentValue: any;
  readonly outcome: 'abort' | 'cancel' | 'set' | 'update' | undefined;
  readonly values: Record<string, any> | undefined;

  abort(): void;
  cancel(): void;
  set(value: any): void;
  update(values: Record<string, any>): void;
}

interface Info {
  readonly connected: boolean | undefined,
  readonly timeOffset: number;
  readonly user: any | undefined,
  readonly userid: string | undefined
}

interface Stats {
  readonly list: StatItem[];
  log(n: number): void;
  wrap<T>(getter: () => T, className: string, name: string): () => T;
}

interface StatItem {
  name: string;
  numRecomputes: number;
  numUpdates: number;
  runtime: number;
  runtimePerRecompute: number;
}

type InterceptActionKey =
  'read' | 'write' | 'auth' | 'set' | 'update' | 'commit' | 'connect' | 'peek' | 'authenticate' |
  'unathenticate' | 'certify' | 'all';

interface InterceptCallbacks {
  onBefore?: (op: Truss.Operation) => Promise<void> | undefined,
  onAfter?: (op: Truss.Operation) => Promise<void> | undefined,
  onError?: (op: Truss.Operation, error: Error) => Promise<boolean> | boolean | undefined,
  onFailure?: (op: Truss.Operation) => Promise<void> | undefined
}

interface Connections {
  [key: string]: Truss.Query | Truss.Reference | Connections | References | undefined;
}

interface WorkerFunctions {
  [key: string]: (...args: any[]) => Promise<any> | WorkerFunctions;
}


declare module 'vue/types/vue' {
  interface Vue extends BaseModel {
    readonly $truss: Truss;
    readonly $store: any;
  }
}
