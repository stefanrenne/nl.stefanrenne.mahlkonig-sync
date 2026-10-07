// Client for the Mahlkönig Sync cloud API, as used by the official Sync mobile app.
// No Homey code in here, so it can be tested on its own. docs/sync-api.md documents every
// endpoint, field and unit used below, and where each was observed.

export const DEFAULT_BASE_URL = 'https://sync.mahlkoenig.com/api';

// Refresh or log in again this long before the access token expires (tokens live 600 s).
const EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;

/** The cloud rejected the e-mail/password (or the refreshed session). */
export class SyncAuthError extends Error {
  constructor(message = 'Mahlkönig Sync rejected the credentials') {
    super(message);
    this.name = 'SyncAuthError';
  }
}

/** A network failure or an unexpected response from the cloud. */
export class SyncApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SyncApiError';
    this.status = status;
  }
}

export interface SyncCredentials {
  email: string;
  password: string;
}

export interface SyncClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface RawDevice {
  deviceId: string | number;
  serial?: string;
  type?: string;
  subType?: string;
  companyId?: string | number;
  status?: {
    cloudDate?: string;
    deviceDate?: string;
    status?: {
      standbyActive?: boolean;
      motorTemperature?: number;
      motorOnTime?: number;
      discUsageTime?: number;
      discHealth?: number;
      hmiSwVersion?: string;
      espSwVersion?: string;
      bundleVersion?: string;
      timeZone?: string;
    };
  } | null;
}

/** A Sync Scale from the device-union list, with the grinder it's paired with. */
export interface RawScale {
  deviceId: string | number;
  serial?: string;
  type?: string;
  deviceClass?: string;
  bindings?: {
    toDeviceId?: string | number;
    toDevice?: RawDevice;
  }[] | null;
}

export interface RawGrindEvent {
  eventUuid?: string;
  deviceId?: string | number;
  cloudDate?: string;
  deviceDate?: string;
  localDate?: string;
  payload?: {
    recipeIndex?: number;
    recipeMode?: string;
    recipeType?: string;
    filterType?: string;
    durationActual?: number;
    durationRecipe?: number;
    weightActual?: number;
    weightRecipe?: number;
    dddActual?: number;
    dddRecipe?: number;
    brewTimeRecipe?: number;
    triggerMode?: string;
    successful?: boolean;
  };
}

export interface RawBrewEvent {
  eventUuid?: string;
  deviceId?: string | number;
  cloudDate?: string;
  deviceDate?: string;
  payload?: {
    duration?: number;
    mass?: number;
    stopType?: string;
    /** The grind this shot belongs to (missing for a shot without a grind). */
    grindEventUuid?: string;
    grinderId?: string | number;
  };
  /** The cloud's verdict on a shot with a grind: "PERFECT", "OK", … */
  shotQuality?: { overall?: string; brewTime?: string; grindWeight?: string } | null;
}

export interface RawBrewerBinding {
  grinderId?: string | number;
  brewerId?: string | number;
  brewer?: { brewerId?: string | number; serial?: string; type?: string };
}

export interface LastEvents {
  lastGrind: RawGrindEvent | null;
  lastBrew: RawBrewEvent | null;
}

interface Session {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string | undefined;
  refreshExpiresAt: number | undefined;
  companyId: string | number | undefined;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number; // milliseconds
  access_expires?: string;
  refresh_expires?: string;
  details?: { comp?: string | number };
}

export class SyncClient {
  private readonly credentials: SyncCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private session: Session | undefined;
  private pendingSession: Promise<Session> | undefined;

  constructor(credentials: SyncCredentials, options: SyncClientOptions = {}) {
    this.credentials = credentials;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The account's company id, known after the first login. */
  get companyId(): string | number | undefined {
    return this.session?.companyId;
  }

  /** Logs in with e-mail and password. Throws SyncAuthError when the cloud rejects them. */
  async login(): Promise<void> {
    this.session = await this.createSession();
  }

  /** The newest grind and brew event of the account ("current" device, decided by the cloud). */
  async getLastEvents(): Promise<LastEvents> {
    const result = await this.request<Partial<LastEvents> | null>('POST', '/mobile-service/stats/event/last-events', {
      limitToCurrentDevice: true,
    });
    return { lastGrind: result?.lastGrind ?? null, lastBrew: result?.lastBrew ?? null };
  }

  /** Grind events of one grinder whose device date falls between from and to. */
  async findGrindEvents(deviceId: string | number, from: Date, to: Date): Promise<RawGrindEvent[]> {
    const result = await this.request<RawGrindEvent[] | null>('POST', '/mobile-service/grind-event/find', this.eventQuery(deviceId, from, to));
    return Array.isArray(result) ? result : [];
  }

  /** Brew events of one Sync Scale whose device date falls between from and to. */
  async findBrewEvents(deviceId: string | number, from: Date, to: Date): Promise<RawBrewEvent[]> {
    const result = await this.request<RawBrewEvent[] | null>('POST', '/mobile-service/device-event/brew-event/find', this.eventQuery(deviceId, from, to));
    return Array.isArray(result) ? result : [];
  }

  /** A device record, including its status block (standby, motor temperature, firmware). */
  async getDevice(deviceId: string | number): Promise<RawDevice> {
    return this.request<RawDevice>('GET', `/mobile-service/device/?key=${encodeURIComponent(String(deviceId))}`);
  }

  /** The Sync Scale paired with a grinder, if any. */
  async getScaleBinding(grinderId: string | number): Promise<RawBrewerBinding | null> {
    const result = await this.request<{ items?: RawBrewerBinding[] } | null>('POST', '/mobile-service/brewer-binding/query', {
      orderDir: 'DESC',
      loadDevice: true,
      brewerId: null,
      grinderId,
    });
    return result?.items?.find((binding) => binding.brewer?.type === 'scale' || binding.brewerId != null) ?? null;
  }

  /**
   * The account's grinders. Uses the company device list (works for home accounts) and falls
   * back to the device of the newest grind event when that list is empty or refused.
   */
  async listGrinders(): Promise<RawDevice[]> {
    await this.ensureSession();
    try {
      const result = await this.request<{ items?: RawDevice[] } | null>('POST', '/admin-service/device/query', {
        companyId: this.companyId,
        loadStatus: true,
        pager: { firstResult: 0, pageSize: 50 },
      });
      const grinders = (result?.items ?? []).filter((device) => device.type !== undefined && device.type !== 'scale');
      if (grinders.length > 0) {
        return grinders;
      }
    } catch (error) {
      if (!(error instanceof SyncApiError)) {
        throw error;
      }
    }
    const { lastGrind } = await this.getLastEvents();
    const device = (lastGrind as { device?: RawDevice } | null)?.device;
    return device?.deviceId != null ? [device] : [];
  }

  /**
   * The account's Sync Scales, as the official app lists them (`device-union/query` with
   * `deviceClasses: ["SCALE"]`). Falls back to the scales paired with the company's grinders when
   * that list is refused.
   */
  async listScales(): Promise<RawScale[]> {
    try {
      const result = await this.request<{ items?: RawScale[] } | null>('POST', '/mobile-service/device-union/query', {
        pager: null,
        keyword: null,
        orderBy: 'change.date',
        orderDir: 'DESC',
        loadStore: true,
        loadBindings: true,
        excludeTypes: ['xenia'],
        deviceClasses: ['SCALE'],
      });
      return result?.items ?? [];
    } catch (error) {
      if (!(error instanceof SyncApiError)) {
        throw error;
      }
    }
    await this.ensureSession();
    const result = await this.request<{ items?: (RawDevice & { bindings?: RawBrewerBinding[] | null })[] } | null>(
      'POST', '/admin-service/device/query', {
        companyId: this.companyId,
        loadBindings: true,
        pager: { firstResult: 0, pageSize: 50 },
      });
    const scales = new Map<string, RawScale>();
    for (const grinder of result?.items ?? []) {
      for (const binding of grinder.bindings ?? []) {
        const id = binding.brewer?.brewerId ?? binding.brewerId;
        if (id != null && binding.brewer?.type !== undefined && binding.brewer.type !== 'scale') {
          continue;
        }
        if (id != null && !scales.has(String(id))) {
          scales.set(String(id), {
            deviceId: id,
            serial: binding.brewer?.serial,
            type: 'scale',
            bindings: [{ toDeviceId: grinder.deviceId, toDevice: grinder }],
          });
        }
      }
    }
    return [...scales.values()];
  }

  private eventQuery(deviceId: string | number, from: Date, to: Date) {
    return {
      deviceDateRange: { from: from.toISOString(), to: to.toISOString() },
      orderBy: 'deviceDate',
      orderDir: 'DESC',
      loadDevice: false,
      deviceIds: [deviceId],
      storeIds2: null,
      storeIds: null,
      regionIds: null,
      companyIds: null,
    };
  }

  /** An authenticated request. On 401/403 it logs in again once and retries. */
  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let session = await this.ensureSession();
    let response = await this.send(method, path, { body, token: session.accessToken });
    if (response.status === 401 || response.status === 403) {
      this.session = undefined;
      session = await this.ensureSession();
      response = await this.send(method, path, { body, token: session.accessToken });
    }
    return this.json<T>(response, path);
  }

  /** A valid session: the current one, a refreshed one, or a fresh login. Concurrent callers share one attempt. */
  private ensureSession(): Promise<Session> {
    const session = this.session;
    if (session !== undefined && session.accessExpiresAt - EXPIRY_MARGIN_MS > this.now()) {
      return Promise.resolve(session);
    }
    this.pendingSession ??= this.renewSession().finally(() => {
      this.pendingSession = undefined;
    });
    return this.pendingSession;
  }

  private async renewSession(): Promise<Session> {
    const old = this.session;
    if (old?.refreshToken !== undefined && (old.refreshExpiresAt ?? 0) - EXPIRY_MARGIN_MS > this.now()) {
      try {
        const response = await this.send('GET', '/security-service/auth/refresh', { token: old.refreshToken });
        if (response.ok) {
          this.session = this.toSession(await this.json<TokenResponse>(response, 'refresh'), old);
          return this.session;
        }
      } catch (error) {
        if (!(error instanceof SyncApiError) && !(error instanceof SyncAuthError)) {
          throw error;
        }
      }
    }
    this.session = await this.createSession();
    return this.session;
  }

  private async createSession(): Promise<Session> {
    const response = await this.send('POST', '/security-service/auth/token', {
      body: { username: this.credentials.email, password: this.credentials.password },
    });
    // What a wrong password returns exactly is unverified (docs/sync-api.md, Q1).
    if ([400, 401, 403].includes(response.status)) {
      throw new SyncAuthError();
    }
    return this.toSession(await this.json<TokenResponse>(response, 'login'), undefined);
  }

  private toSession(token: TokenResponse | null, previous: Session | undefined): Session {
    if (!token?.access_token) {
      throw new SyncAuthError('Mahlkönig Sync returned no access token');
    }
    const now = this.now();
    const accessExpires = token.access_expires ? Date.parse(token.access_expires) : NaN;
    const refreshExpires = token.refresh_expires ? Date.parse(token.refresh_expires) : NaN;
    return {
      accessToken: token.access_token,
      accessExpiresAt: Number.isFinite(accessExpires) ? accessExpires : now + (token.expires_in ?? 600_000),
      // The refresh response carries no refresh token: the original one keeps working.
      refreshToken: token.refresh_token ?? previous?.refreshToken,
      refreshExpiresAt: Number.isFinite(refreshExpires) ? refreshExpires : previous?.refreshExpiresAt,
      companyId: token.details?.comp ?? previous?.companyId,
    };
  }

  private async send(method: 'GET' | 'POST', path: string, options: { body?: unknown; token?: string }): Promise<Response> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (options.token !== undefined) {
      headers.authorization = `Bearer ${options.token}`;
    }
    try {
      return await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SyncApiError(`Could not reach Mahlkönig Sync (${reason})`);
    }
  }

  private async json<T>(response: Response, what: string): Promise<T> {
    if (!response.ok) {
      throw new SyncApiError(`Mahlkönig Sync answered HTTP ${response.status} (${what.split('?')[0]})`, response.status);
    }
    const text = await response.text();
    if (text.trim() === '') {
      return null as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SyncApiError(`Mahlkönig Sync sent an unreadable response (${what.split('?')[0]})`, response.status);
    }
  }
}
