import { EventEmitter } from "events";
import pino, { Logger } from "pino";
import KeyValueStorage, { IKeyValueStorage } from "keyvaluestorage";
import {
  IClient,
  ClientOptions,
  ClientTypes,
  PairingTypes,
  SessionTypes,
} from "@walletconnect/types";
import {
  isPairingFailed,
  isSessionFailed,
  parseUri,
  isPairingResponded,
  isSessionResponded,
  getPairingMetadata,
} from "@walletconnect/utils";
import { JsonRpcPayload, isJsonRpcRequest } from "@json-rpc-tools/utils";
import { generateChildLogger, getDefaultLoggerOptions } from "@pedrouid/pino-utils";

import { Pairing, Session, Relayer } from "./controllers";
import {
  CLIENT_CONTEXT,
  CLIENT_EVENTS,
  CLIENT_STORAGE_OPTIONS,
  PAIRING_DEFAULT_TTL,
  PAIRING_EVENTS,
  PAIRING_SIGNAL_METHOD_URI,
  RELAYER_DEFAULT_PROTOCOL,
  SESSION_EMPTY_PERMISSIONS,
  SESSION_EMPTY_RESPONSE,
  SESSION_EVENTS,
  SESSION_JSONRPC,
  SESSION_SIGNAL_METHOD_PAIRING,
} from "./constants";

export class Client extends IClient {
  public readonly protocol = "wc";
  public readonly version = 2;

  public events = new EventEmitter();
  public logger: Logger;

  public relayer: Relayer;
  public storage: IKeyValueStorage;

  public pairing: Pairing;
  public session: Session;

  public context: string = CLIENT_CONTEXT;

  static async init(opts?: ClientOptions): Promise<Client> {
    const client = new Client(opts);
    await client.initialize();
    return client;
  }

  constructor(opts?: ClientOptions) {
    super(opts);
    const logger =
      typeof opts?.logger !== "undefined" && typeof opts?.logger !== "string"
        ? opts.logger
        : pino(getDefaultLoggerOptions({ level: opts?.logger }));
    this.context = opts?.overrideContext || this.context;
    this.logger = generateChildLogger(logger, this.context);

    this.relayer = new Relayer(this, this.logger, opts?.relayProvider);
    this.storage =
      opts?.storage || new KeyValueStorage({ ...CLIENT_STORAGE_OPTIONS, ...opts?.storageOptions });

    this.pairing = new Pairing(this, this.logger);
    this.session = new Session(this, this.logger);
  }

  public on(event: string, listener: any): void {
    this.events.on(event, listener);
  }

  public once(event: string, listener: any): void {
    this.events.once(event, listener);
  }

  public off(event: string, listener: any): void {
    this.events.off(event, listener);
  }

  public removeListener(event: string, listener: any): void {
    this.events.removeListener(event, listener);
  }

  public async connect(params: ClientTypes.ConnectParams): Promise<SessionTypes.Settled> {
    this.logger.debug(`Connecting Application`);
    this.logger.trace({ type: "method", method: "connect", params });
    try {
      if (typeof params.pairing === undefined) {
        this.logger.info("Connecing with existing pairing");
      }
      const pairing =
        typeof params.pairing === "undefined"
          ? await this.pairing.create()
          : await this.pairing.get(params.pairing.topic);
      this.logger.trace({ type: "method", method: "connect", pairing });
      const session = await this.session.create({
        signal: { method: SESSION_SIGNAL_METHOD_PAIRING, params: { topic: pairing.topic } },
        relay: params.relay || { protocol: RELAYER_DEFAULT_PROTOCOL },
        metadata: params.metadata,
        permissions: {
          ...params.permissions,
          notifications: SESSION_EMPTY_PERMISSIONS.notifications,
        },
      });
      this.logger.debug(`Application Connection Successful`);
      this.logger.trace({ type: "method", method: "connect", session });
      return session;
    } catch (e) {
      this.logger.debug(`Application Connection Failure`);
      this.logger.error(e);
      throw e;
    }
  }

  public async pair(params: ClientTypes.PairParams): Promise<void> {
    this.logger.debug(`Pairing`);
    this.logger.trace({ type: "method", method: "pair", params });
    const proposal = formatPairingProposal(params.uri);
    const pending = await this.pairing.respond({ approved: true, proposal });
    if (!isPairingResponded(pending)) return;
    if (isPairingFailed(pending.outcome)) {
      this.logger.debug(`Pairing Failure`);
      this.logger.trace({ type: "method", method: "pair", outcome: pending.outcome });
      return;
    }
    this.logger.debug(`Pairing Success`);
    this.logger.trace({ type: "method", method: "pair", pending });
  }

  public async approve(params: ClientTypes.ApproveParams): Promise<SessionTypes.Settled> {
    this.logger.debug(`Approving Session Proposal`);
    this.logger.trace({ type: "method", method: "approve", params });
    if (typeof params.response === "undefined") {
      const errorMessage = "Response is required for approved session proposals";
      this.logger.error(errorMessage);
      throw new Error(errorMessage);
    }
    const pending = await this.session.respond({
      approved: true,
      proposal: params.proposal,
      response: params.response || SESSION_EMPTY_RESPONSE,
    });
    if (!isSessionResponded(pending)) {
      const errorMessage = "No Session Response found in pending proposal";
      this.logger.error(errorMessage);
      throw new Error(errorMessage);
    }
    if (isSessionFailed(pending.outcome)) {
      this.logger.debug(`Session Proposal Approval Failure`);
      this.logger.trace({ type: "method", method: "approve", outcome: pending.outcome });
      throw new Error(pending.outcome.reason);
    }
    this.logger.debug(`Session Proposal Approval Success`);
    this.logger.trace({ type: "method", method: "approve", pending });
    return this.session.get(pending.outcome.topic);
  }

  public async reject(params: ClientTypes.RejectParams): Promise<void> {
    this.logger.debug(`Rejecting Session Proposal`);
    this.logger.trace({ type: "method", method: "reject", params });
    const pending = await this.session.respond({
      approved: false,
      proposal: params.proposal,
      response: SESSION_EMPTY_RESPONSE,
    });
    this.logger.debug(`Session Proposal Response Success`);
    this.logger.trace({ type: "method", method: "reject", pending });
  }

  public async update(params: ClientTypes.UpdateParams): Promise<void> {
    await this.session.update(params);
  }

  public async notify(params: ClientTypes.NotifyParams): Promise<void> {
    await this.session.notify(params);
  }

  public async request(params: ClientTypes.RequestParams): Promise<any> {
    return this.session.request(params);
  }

  public async respond(params: ClientTypes.RespondParams): Promise<void> {
    await this.session.send(params.topic, params.response);
  }

  public async disconnect(params: ClientTypes.DisconnectParams): Promise<void> {
    this.logger.debug(`Disconnecting Application`);
    this.logger.trace({ type: "method", method: "disconnect", params });
    await this.session.delete(params);
  }

  // ---------- Protected ----------------------------------------------- //

  protected async onPairingPayload(payload: JsonRpcPayload): Promise<void> {
    if (isJsonRpcRequest(payload)) {
      if (payload.method === SESSION_JSONRPC.propose) {
        this.logger.info(`Emitting ${CLIENT_EVENTS.session.proposal}`);
        this.logger.debug({
          type: "event",
          event: CLIENT_EVENTS.session.proposal,
          data: payload.params,
        });
        this.events.emit(CLIENT_EVENTS.session.proposal, payload.params);
      }
    }
  }

  protected async onPairingSettled(pairing: PairingTypes.Settled) {
    const metadata = getPairingMetadata();
    if (typeof metadata === "undefined") return;
    const update: PairingTypes.Update = { peer: { metadata } };
    this.pairing.update({ topic: pairing.topic, update });
  }
  // ---------- Private ----------------------------------------------- //

  private async initialize(): Promise<any> {
    this.logger.trace(`Initialized`);
    try {
      await this.relayer.init();
      await this.pairing.init();
      await this.session.init();
      this.registerEventListeners();
      this.logger.info(`Client Initilization Success`);
    } catch (e) {
      this.logger.info(`Client Initilization Failure`);
      this.logger.error(e);
      throw e;
    }
  }

  private registerEventListeners(): void {
    // Pairing Subscription Events
    this.pairing.on(PAIRING_EVENTS.proposed, (pending: PairingTypes.Pending) => {
      this.logger.info(`Emitting ${CLIENT_EVENTS.pairing.proposal}`);
      this.logger.debug({
        type: "event",
        event: CLIENT_EVENTS.pairing.proposal,
        data: pending.proposal,
      });
      this.events.emit(CLIENT_EVENTS.pairing.proposal, pending.proposal);
    });

    this.pairing.on(PAIRING_EVENTS.settled, (pairing: PairingTypes.Settled) => {
      this.logger.info(`Emitting ${CLIENT_EVENTS.pairing.created}`);
      this.logger.debug({
        type: "event",
        event: CLIENT_EVENTS.pairing.created,
        data: pairing,
      });
      this.events.emit(CLIENT_EVENTS.pairing.created, pairing);
      this.onPairingSettled(pairing);
    });
    this.pairing.on(PAIRING_EVENTS.updated, (pairing: PairingTypes.Settled) => {
      this.logger.info(`Emitting ${CLIENT_EVENTS.pairing.updated}`);
      this.logger.debug({
        type: "event",
        event: CLIENT_EVENTS.pairing.updated,
        data: pairing,
      });
      this.events.emit(CLIENT_EVENTS.pairing.updated, pairing);
    });
    this.pairing.on(PAIRING_EVENTS.deleted, (pairing: PairingTypes.Settled) => {
      this.logger.info(`Emitting ${CLIENT_EVENTS.pairing.deleted}`);
      this.logger.debug({
        type: "event",
        event: CLIENT_EVENTS.pairing.deleted,
        data: pairing,
      });
      this.events.emit(CLIENT_EVENTS.pairing.deleted, pairing);
    });
    this.pairing.on(PAIRING_EVENTS.payload, (payloadEvent: PairingTypes.PayloadEvent) => {
      this.onPairingPayload(payloadEvent.payload);
    });
    // Session Subscription Events
    this.session.on(SESSION_EVENTS.proposed, (pending: SessionTypes.Pending) => {
      this.logger.info(`Emitting ${CLIENT_EVENTS.session.proposal}`);
      this.logger.debug({
        type: "event",
        event: CLIENT_EVENTS.session.proposal,
        data: pending.proposal,
      });
      this.events.emit(CLIENT_EVENTS.session.proposal, pending.proposal);
    });
    this.session.on(SESSION_EVENTS.settled, (session: SessionTypes.Settled) => {
      this.logger.info(`Emitting ${CLIENT_EVENTS.session.created}`);
      this.logger.debug({ type: "event", event: CLIENT_EVENTS.session.created, data: session });
      this.events.emit(CLIENT_EVENTS.session.created, session);
    });
    this.session.on(SESSION_EVENTS.updated, (session: SessionTypes.Settled) => {
      this.logger.info(`Emitting ${CLIENT_EVENTS.session.updated}`);
      this.logger.debug({ type: "event", event: CLIENT_EVENTS.session.updated, data: session });
      this.events.emit(CLIENT_EVENTS.session.updated, session);
    });
    this.session.on(SESSION_EVENTS.deleted, (session: SessionTypes.Settled) => {
      this.logger.info(`Emitting ${CLIENT_EVENTS.session.deleted}`);
      this.logger.debug({ type: "event", event: CLIENT_EVENTS.session.deleted, data: session });
      this.events.emit(CLIENT_EVENTS.session.deleted, session);
    });
    this.session.on(SESSION_EVENTS.payload, (payloadEvent: SessionTypes.PayloadEvent) => {
      this.logger.info(`Emitting ${CLIENT_EVENTS.session.payload}`);
      this.logger.debug({
        type: "event",
        event: CLIENT_EVENTS.session.payload,
        data: payloadEvent,
      });
      this.events.emit(CLIENT_EVENTS.session.payload, payloadEvent);
    });
    this.session.on(
      SESSION_EVENTS.notification,
      (notificationEvent: SessionTypes.NotificationEvent) => {
        this.logger.info(`Emitting ${CLIENT_EVENTS.session.notification}`);
        this.logger.debug({
          type: "event",
          event: CLIENT_EVENTS.session.notification,
          data: notificationEvent,
        });
        this.events.emit(CLIENT_EVENTS.session.notification, notificationEvent);
      },
    );
  }
}

function formatPairingProposal(uri: string): PairingTypes.Proposal {
  const uriParams = parseUri(uri);
  return {
    topic: uriParams.topic,
    relay: uriParams.relay,
    proposer: { publicKey: uriParams.publicKey },
    signal: { method: PAIRING_SIGNAL_METHOD_URI, params: { uri } },
    permissions: { jsonrpc: { methods: [SESSION_JSONRPC.propose] } },
    ttl: PAIRING_DEFAULT_TTL,
  };
}
