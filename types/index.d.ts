
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
  execution: AssistantExec[],
}

export interface DeviceKey {
  id: string,
  customData?: {[name: string]: any},
}

export interface AssistantExec {
  command: string,
  params: {[name: string]: any},
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

export interface AssistantCommandResult {
  ids: string[],
  status: string,
  errorCode: string,
  states: {[name: string]: any},
}

export interface GenericDevice {
  type: string,
  name: string,
  mac?: string,

  isOn?: boolean,
  brightness?: number,
}

export type DevicesStore = {[mac: string]: GenericDevice};
