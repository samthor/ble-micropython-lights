
export interface AssistantRequest {
  requestId: string,
  inputs: AssistantInput[],
}

export interface AssistantResponse {
  requestId: string,
  payload: any,
}

export interface AssistantInput {
  intent: string,
  payload: {
    commands: AssistantCommand[],
    devices: DeviceKey[],
  },
}

export interface AssistantCommand {
  devices: DeviceKey[],
  execution?: AssistantExec[],
}

export interface DeviceKey {
  id: string,
  customData?: {[name: string]: any},
}

export interface AssistantExecParams {
  on?: boolean;
  thermostatTemperatureSetpointHigh?: number;
  thermostatTemperatureSetpointLow?: number;
  thermostatTemperatureSetpoint?: number;
  thermostatMode?: string;
  fanSpeed?: string;
  brightness?: number;
}

export interface AssistantExec {
  command: string,
  params: AssistantExecParams,
}

export interface DeviceInfo {
  manufacturer?: string,
  model?: string,
  hwVersion?: string,
  swVersion?: string,
}

export interface Device extends DeviceKey {
  type: string,
  traits: string[],  // possible ways of being controlled
  willReportState: boolean,  // true is real-time, false is polling
  roomHint?: string,
  attributes?: {[name: string]: any},
  deviceInfo?: DeviceInfo,

  name: {
    name: string,
    defaultNames?: string[],
    nicknames?: string[],
  },
}

export interface DeviceState {
  errorCode?: string;  // not really here, but useful for reporting failures

  online: boolean;

  on?: boolean;
  brightness?: number;
  thermostatTemperatureSetpoint?: number;
  thermostatTemperatureAmbient?: number;
  thermostatTemperatureSetpointLow?: number;
  thermostatTemperatureSetpointHigh?: number;
  thermostatMode?: string;
  currentFanSpeedSetting?: string;
}

export interface AssistantCommandResult {
  ids: string[],
  status: string,
  errorCode?: string,
  states?: DeviceState,
}

export interface SyncResponse {
  agentUserId: string,
  devices: Device[],
}

export interface QueryResponse {
  devices: {[id: string]: DeviceState},
}

export interface HomegraphNotificationRequest {
  requestId: string,
  agentUserId: string,
  payload: {
    devices: {
      states: {[id: string]: DeviceState},
    },
  },
}

/**
 * This is a device as configured in your code.
 */
export interface GenericDevice {
  type: string,
  name: string,
  mac?: string,
  ip?: string,
}

export type DevicesStore = {[mac: string]: GenericDevice};
