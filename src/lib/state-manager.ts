import type * as utils from "@iobroker/adapter-core";
import { tDesc, tName, tRaw, tText, type I18nKey } from "./i18n";
import { ALL_FLAG_KEYS, descKeyOf, FLAG_META, getDisplayEntries, parseStatus } from "./status-parser";
import { detectStates, detectType } from "./type-detector";
import type { NutCommand, NutVariable } from "./types";

type LocalizedName = ioBroker.StringOrTranslated;

const CHANNEL_I18N: Record<string, I18nKey> = {
  battery: "channelBattery",
  device: "channelDevice",
  driver: "channelDriver",
  input: "channelInput",
  output: "channelOutput",
  ups: "channelUps",
  outlet: "channelOutlet",
  ambient: "channelAmbient",
  status: "channelStatus",
  commands: "channelCommands",
  info: "channelUpsInfo",
};

/**
 * Channels the adapter owns rather than the NUT server: the parsed status flags, the per-UPS info
 * channel and the instant-command buttons. A NUT variable is never allowed to take one of these
 * ids — see {@link StateManager.updateVariables}.
 */
const ADAPTER_OWNED_CHANNELS = new Set(["info", "status", "commands"]);

const COMMAND_I18N: Record<string, I18nKey> = {
  "beeper.disable": "cmdBeeperDisable",
  "beeper.enable": "cmdBeeperEnable",
  "beeper.mute": "cmdBeeperMute",
  "beeper.toggle": "cmdBeeperToggle",
  "load.off": "cmdLoadOff",
  "load.on": "cmdLoadOn",
  "load.off.delay": "cmdLoadOffDelay",
  "load.on.delay": "cmdLoadOnDelay",
  "outlet.load.off": "cmdOutletLoadOff",
  "outlet.load.on": "cmdOutletLoadOn",
  "outlet.load.cycle": "cmdOutletLoadCycle",
  "shutdown.default": "cmdShutdownDefault",
  "shutdown.return": "cmdShutdownReturn",
  "shutdown.stayoff": "cmdShutdownStayoff",
  "shutdown.stop": "cmdShutdownStop",
  "shutdown.reboot": "cmdShutdownReboot",
  "shutdown.reboot.graceful": "cmdShutdownRebootGraceful",
  "test.battery.start": "cmdTestBatteryStart",
  "test.battery.start.quick": "cmdTestBatteryStartQuick",
  "test.battery.start.low": "cmdTestBatteryStartLow",
  "test.battery.start.deep": "cmdTestBatteryStartDeep",
  "test.battery.stop": "cmdTestBatteryStop",
  "test.panel.start": "cmdTestPanelStart",
  "test.panel.stop": "cmdTestPanelStop",
  "test.failure.start": "cmdTestFailureStart",
  "test.failure.stop": "cmdTestFailureStop",
  "test.system.start": "cmdTestSystemStart",
  "calibrate.start": "cmdCalibrateStart",
  "calibrate.stop": "cmdCalibrateStop",
  "bypass.start": "cmdBypassStart",
  "bypass.stop": "cmdBypassStop",
  "reset.input.minmax": "cmdResetInputMinmax",
  "reset.watchdog": "cmdResetWatchdog",
};

const TRANSLATED_VARIABLES = new Set<I18nKey>([
  "ambient.contacts.status",
  "ambient.humidity",
  "ambient.humidity.alarm",
  "ambient.present",
  "ambient.temperature",
  "ambient.temperature.status",
  "battery.alarm.threshold",
  "battery.capacity",
  "battery.capacity.nominal",
  "battery.charge",
  "battery.charge.approx",
  "battery.charge.low",
  "battery.charge.restart",
  "battery.charge.warning",
  "battery.charger.status",
  "battery.charger.type",
  "battery.current",
  "battery.current.total",
  "battery.date",
  "battery.date.maintenance",
  "battery.energysave",
  "battery.energysave.delay",
  "battery.energysave.load",
  "battery.energysave.realpower",
  "battery.mfr.date",
  "battery.packs",
  "battery.packs.bad",
  "battery.packs.external",
  "battery.protection",
  "battery.runtime",
  "battery.runtime.low",
  "battery.runtime.restart",
  "battery.status",
  "battery.temperature",
  "battery.temperature.cell.max",
  "battery.temperature.cell.min",
  "battery.type",
  "battery.voltage",
  "battery.voltage.cell.max",
  "battery.voltage.cell.min",
  "battery.voltage.high",
  "battery.voltage.low",
  "battery.voltage.nominal",
  "current.high.critical",
  "current.high.warning",
  "current.low.critical",
  "current.low.warning",
  "current.maximum",
  "current.minimum",
  "current.peak",
  "current.status",
  "device.contact",
  "device.count",
  "device.description",
  "device.location",
  "device.macaddr",
  "device.mfr",
  "device.model",
  "device.part",
  "device.serial",
  "device.type",
  "device.uptime",
  "device.usb.version",
  "driver.flag.allow_killpower",
  "driver.flag.ignorelb",
  "driver.name",
  "driver.parameter.pollfreq",
  "driver.parameter.pollinterval",
  "driver.parameter.port",
  "driver.parameter.synchronous",
  "driver.state",
  "driver.version",
  "driver.version.data",
  "driver.version.internal",
  "driver.version.usb",
  "frequency.nominal",
  "input.bypass.frequency",
  "input.bypass.switch.off",
  "input.bypass.switch.on",
  "input.bypass.switchable",
  "input.bypass.voltage",
  "input.current",
  "input.current.high.critical",
  "input.current.high.warning",
  "input.current.low.critical",
  "input.current.low.warning",
  "input.current.nominal",
  "input.current.status",
  "input.eco.switchable",
  "input.feed.color",
  "input.feed.desc",
  "input.frequency",
  "input.frequency.extended",
  "input.frequency.high",
  "input.frequency.low",
  "input.frequency.nominal",
  "input.frequency.nominal.range",
  "input.frequency.status",
  "input.load",
  "input.phase.shift",
  "input.phases",
  "input.power",
  "input.quality",
  "input.realpower",
  "input.realpower.nominal",
  "input.sensitivity",
  "input.source",
  "input.source.preferred",
  "input.transfer.boost.high",
  "input.transfer.boost.low",
  "input.transfer.bypass.forced",
  "input.transfer.bypass.high",
  "input.transfer.bypass.low",
  "input.transfer.bypass.outlimits",
  "input.transfer.bypass.overload",
  "input.transfer.delay",
  "input.transfer.eco.high",
  "input.transfer.eco.low",
  "input.transfer.frequency.bypass.range",
  "input.transfer.frequency.eco.range",
  "input.transfer.high",
  "input.transfer.high.max",
  "input.transfer.high.min",
  "input.transfer.hysteresis",
  "input.transfer.low",
  "input.transfer.low.max",
  "input.transfer.low.min",
  "input.transfer.reason",
  "input.transfer.trim.high",
  "input.transfer.trim.low",
  "input.voltage",
  "input.voltage.extended",
  "input.voltage.high.critical",
  "input.voltage.high.warning",
  "input.voltage.low.critical",
  "input.voltage.low.warning",
  "input.voltage.maximum",
  "input.voltage.minimum",
  "input.voltage.nominal",
  "input.voltage.status",
  "outlet.count",
  "outlet.current",
  "outlet.delay.shutdown",
  "outlet.desc",
  "outlet.group.id",
  "outlet.group.status",
  "outlet.group.type",
  "outlet.id",
  "outlet.status",
  "outlet.switchable",
  "output.current",
  "output.current.nominal",
  "output.frequency",
  "output.frequency.nominal",
  "output.inverter.latency",
  "output.phases",
  "output.power",
  "output.voltage",
  "output.voltage.nominal",
  "power.maximum",
  "power.maximum.percent",
  "power.minimum",
  "power.minimum.percent",
  "power.percent",
  "ups.alarm",
  "ups.beeper.status",
  "ups.contacts",
  "ups.date",
  "ups.delay.reboot",
  "ups.delay.shutdown",
  "ups.delay.start",
  "ups.display.language",
  "ups.efficiency",
  "ups.firmware",
  "ups.firmware.aux",
  "ups.id",
  "ups.load",
  "ups.load.high",
  "ups.mfr",
  "ups.mfr.date",
  "ups.mode",
  "ups.model",
  "ups.power",
  "ups.power.nominal",
  "ups.productid",
  "ups.realpower",
  "ups.realpower.nominal",
  "ups.serial",
  "ups.shutdown",
  "ups.start.auto",
  "ups.start.battery",
  "ups.start.reboot",
  "ups.status",
  "ups.temperature",
  "ups.test.date",
  "ups.test.interval",
  "ups.test.result",
  "ups.time",
  "ups.timer.reboot",
  "ups.timer.shutdown",
  "ups.timer.start",
  "ups.type",
  "ups.vendorid",
  "ups.watchdog.status",
  "voltage.high.critical",
  "voltage.high.warning",
  "voltage.low.critical",
  "voltage.low.warning",
  "voltage.maximum",
  "voltage.minimum",
  "voltage.nominal",
  "voltage.status",
] as I18nKey[]);

/**
 * Split a per-instance or phase segment (`ambient.2.`, `input.L1.`, `input.L1-L2.`, `input.N.`) off
 * the variable name, so three-phase and multi-sensor readings reuse the label and the explanation
 * of the variable they are a variant of — while keeping the segment that tells them apart.
 *
 * One definition for all three lookups: name, marker and description have to collapse identically,
 * and when the rule lived twice a change to one of them would have split a variant's label from its
 * explanation without any test noticing.
 *
 * @param nutVarName NUT variable name
 * @returns base name and the markers found, or undefined when the name carries no variant segment
 */
function splitVariant(nutVarName: string): { generic: string; markers: string[] } | undefined {
  const markers: string[] = [];
  // Global on purpose: a name can carry TWO variant segments. `ambient.1.contacts.1.status` is a
  // real catalog variable, and collapsing only the first one left `ambient.contacts.1.status` —
  // a name the catalog does not know, so the sensor's contacts had neither a translated label nor
  // an explanation. No catalog name loses meaning by collapsing every variant segment.
  const generic = nutVarName.replace(/\.(\d+|L\d(-(L\d|N))?|N)\./g, (_match, segment: string) => {
    markers.push(segment);
    return ".";
  });
  return markers.length ? { generic, markers } : undefined;
}

/**
 * Collapse a variant name to its base name.
 *
 * @param nutVarName NUT variable name
 * @returns the base name, or undefined when the name carries no variant segment
 */
function genericVariantOf(nutVarName: string): string | undefined {
  return splitVariant(nutVarName)?.generic;
}

/**
 * Put the variant markers back in front of a base label, in the shape the untranslated fallback
 * produces them (`L1 current`).
 *
 * Without this, every variant of a catalogued variable carries the SAME label as its siblings:
 * the three `input.Lx.voltage` of a three-phase UPS were all called "Input voltage", and so were
 * both `ambient.n.temperature` and all three `outlet.n.status`. The translation is worth nothing
 * if it costs the reader the one segment that says WHICH phase, sensor or outlet is meant.
 *
 * @param label Translated base label
 * @param markers Variant segments, in the order they appear in the variable name
 */
function withVariantMarker(label: LocalizedName, markers: string[]): LocalizedName {
  if (markers.length === 0) {
    return label;
  }
  const prefix = `${markers.join(" ")} `;
  if (typeof label === "string") {
    return `${prefix}${label}`;
  }
  return Object.fromEntries(Object.entries(label).map(([lang, text]) => [lang, `${prefix}${text}`])) as LocalizedName;
}

/**
 * The catalog entry behind an instant command, plus the variant markers it carried.
 *
 * `outlet.n.load.off` and its two siblings are per-outlet VARIANTS of one documented command, so
 * they resolve through the same collapse as a variable — with the outlet number kept in front.
 * Without it a PDU showed "Outlet 1 load off" in all eleven languages and explained nothing, while
 * the very same button on a UPS without outlets was translated.
 *
 * Returns the KEY rather than the finished texts so `tName`/`tDesc` stay at the call site, where
 * the state-role gate can see that neither is built from a runtime value.
 *
 * @param cmdName NUT command name
 */
function commandCatalogEntry(cmdName: string): { key: I18nKey; markers: string[] } | undefined {
  const direct = COMMAND_I18N[cmdName];
  if (direct) {
    return { key: direct, markers: [] };
  }
  const variant = splitVariant(cmdName);
  const key = variant ? COMMAND_I18N[variant.generic] : undefined;
  return key && variant ? { key, markers: variant.markers } : undefined;
}

function varTranslation(nutVarName: string): LocalizedName | undefined {
  if (TRANSLATED_VARIABLES.has(nutVarName as I18nKey)) {
    return tName(nutVarName as I18nKey);
  }
  const variant = splitVariant(nutVarName);
  if (variant && TRANSLATED_VARIABLES.has(variant.generic as I18nKey)) {
    return withVariantMarker(tName(variant.generic as I18nKey), variant.markers);
  }
  return undefined;
}

/**
 * Sanitize a NUT UPS name into an object-ID-safe segment: only A-Za-z0-9_- survive, everything
 * else (spaces, dots, ioBroker FORBIDDEN_CHARS) becomes an underscore. The result is the object ID;
 * the real NUT name is kept separately for the protocol (INSTCMD/SET VAR/LIST VAR).
 *
 * @param name Raw UPS name as reported by LIST UPS
 */
export function sanitizeUpsName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Convert NUT variable name to ioBroker state ID (dots after channel → dashes).
 *
 * @param upsName UPS identifier
 * @param nutVarName NUT variable name
 */
export function nutVarToStateId(upsName: string, nutVarName: string): string {
  const firstDot = nutVarName.indexOf(".");
  if (firstDot < 0) {
    return `${upsName}.${nutVarName}`;
  }
  const channel = nutVarName.slice(0, firstDot);
  const leaf = nutVarName.slice(firstDot + 1).replace(/\./g, "-");
  return `${upsName}.${channel}.${leaf}`;
}

/**
 * Format NUT variable name as human-readable label.
 *
 * @param nutVarName NUT variable name
 */
export function nutVarToReadableName(nutVarName: string): string {
  const firstDot = nutVarName.indexOf(".");
  const leaf = firstDot >= 0 ? nutVarName.slice(firstDot + 1) : nutVarName;
  return leaf.replace(/\./g, " ").replace(/^./, c => c.toUpperCase());
}

/**
 * Labels for the values of an enum datapoint (`common.states`). ioBroker has no translation
 * object there — a states map is plain strings — so these follow the system language at write
 * time, like every other user-facing label the adapter produces.
 */
const VALUE_I18N: Record<string, I18nKey> = {
  charging: "valCharging",
  discharging: "valDischarging",
  floating: "valFloating",
  resting: "valResting",
  enabled: "valEnabled",
  disabled: "valDisabled",
  muted: "valMuted",
  on: "valOn",
  off: "valOff",
  good: "valGood",
  "warning-low": "valWarningLow",
  "warning-high": "valWarningHigh",
  "critical-low": "valCriticalLow",
  "critical-high": "valCriticalHigh",
  "out-of-range": "valOutOfRange",
  open: "valOpen",
  closed: "valClosed",
  active: "valActive",
  inactive: "valInactive",
  ups: "valUps",
  pdu: "valPdu",
  scd: "valScd",
  psu: "valPsu",
  ats: "valAts",
};

/**
 * Explanations for the NUT variables where the name alone leaves a user guessing. Deliberately
 * NOT one per variable: `device.serial` explains itself, and an invented sentence is worse than
 * none (fleet rule — `common.desc` stays empty where there is nothing to explain).
 */
const VAR_DESC_I18N: Record<string, I18nKey> = {
  "ambient.contacts.status": "descAmbientContactsStatus",
  "ambient.humidity": "descAmbientHumidity",
  "ambient.humidity.alarm": "descAmbientHumidityAlarm",
  "ambient.present": "descAmbientPresent",
  "ambient.temperature": "descAmbientTemperature",
  "ambient.temperature.status": "descAmbientTemperatureStatus",
  "battery.alarm.threshold": "descBatteryAlarmThreshold",
  "battery.capacity": "descBatteryCapacity",
  "battery.capacity.nominal": "descBatteryCapacityNominal",
  "battery.charge": "descBatteryCharge",
  "battery.charge.approx": "descBatteryChargeApprox",
  "battery.charge.low": "descBatteryChargeLow",
  "battery.charge.restart": "descBatteryChargeRestart",
  "battery.charge.warning": "descBatteryChargeWarning",
  "battery.charger.status": "descBatteryChargerStatus",
  "battery.charger.type": "descBatteryChargerType",
  "battery.current": "descBatteryCurrent",
  "battery.current.total": "descBatteryCurrentTotal",
  "battery.date": "descBatteryDate",
  "battery.date.maintenance": "descBatteryDateMaintenance",
  "battery.energysave": "descBatteryEnergysave",
  "battery.energysave.delay": "descBatteryEnergysaveDelay",
  "battery.energysave.load": "descBatteryEnergysaveLoad",
  "battery.energysave.realpower": "descBatteryEnergysaveRealpower",
  "battery.packs": "descBatteryPacks",
  "battery.packs.bad": "descBatteryPacksBad",
  "battery.packs.external": "descBatteryPacksExternal",
  "battery.protection": "descBatteryProtection",
  "battery.runtime": "descBatteryRuntime",
  "battery.runtime.low": "descBatteryRuntimeLow",
  "battery.runtime.restart": "descBatteryRuntimeRestart",
  "battery.status": "descBatteryStatus",
  "battery.temperature": "descBatteryTemperature",
  "battery.temperature.cell.max": "descBatteryTemperatureCellMax",
  "battery.temperature.cell.min": "descBatteryTemperatureCellMin",
  "battery.type": "descBatteryType",
  "battery.voltage": "descBatteryVoltage",
  "battery.voltage.cell.max": "descBatteryVoltageCellMax",
  "battery.voltage.cell.min": "descBatteryVoltageCellMin",
  "battery.voltage.high": "descBatteryVoltageHigh",
  "battery.voltage.low": "descBatteryVoltageLow",
  "battery.voltage.nominal": "descBatteryVoltageNominal",
  "current.high.critical": "descCurrentHighCritical",
  "current.high.warning": "descCurrentHighWarning",
  "current.low.critical": "descCurrentLowCritical",
  "current.low.warning": "descCurrentLowWarning",
  "current.maximum": "descCurrentMaximum",
  "current.minimum": "descCurrentMinimum",
  "current.peak": "descCurrentPeak",
  "current.status": "descCurrentStatus",
  "device.count": "descDeviceCount",
  "device.macaddr": "descDeviceMacaddr",
  "device.part": "descDevicePart",
  "device.type": "descDeviceType",
  "device.uptime": "descDeviceUptime",
  "device.usb.version": "descDeviceUsbVersion",
  "driver.flag.allow_killpower": "descDriverFlagAllowKillpower",
  "driver.flag.ignorelb": "descDriverFlagIgnorelb",
  "driver.parameter.pollfreq": "descDriverParameterPollfreq",
  "driver.parameter.pollinterval": "descDriverParameterPollinterval",
  "driver.state": "descDriverState",
  "driver.version": "descDriverVersion",
  "driver.version.data": "descDriverVersionData",
  "driver.version.internal": "descDriverVersionInternal",
  "frequency.nominal": "descFrequencyNominal",
  "input.bypass.frequency": "descInputBypassFrequency",
  "input.bypass.switch.off": "descInputBypassSwitchOff",
  "input.bypass.switch.on": "descInputBypassSwitchOn",
  "input.bypass.switchable": "descInputBypassSwitchable",
  "input.bypass.voltage": "descInputBypassVoltage",
  "input.current": "descInputCurrent",
  "input.current.high.critical": "descInputCurrentHighCritical",
  "input.current.high.warning": "descInputCurrentHighWarning",
  "input.current.low.critical": "descInputCurrentLowCritical",
  "input.current.low.warning": "descInputCurrentLowWarning",
  "input.current.nominal": "descInputCurrentNominal",
  "input.current.status": "descInputCurrentStatus",
  "input.eco.switchable": "descInputEcoSwitchable",
  "input.feed.color": "descInputFeedColor",
  "input.feed.desc": "descInputFeedDesc",
  "input.frequency": "descInputFrequency",
  "input.frequency.extended": "descInputFrequencyExtended",
  "input.frequency.high": "descInputFrequencyHigh",
  "input.frequency.low": "descInputFrequencyLow",
  "input.frequency.nominal": "descInputFrequencyNominal",
  "input.frequency.nominal.range": "descInputFrequencyNominalRange",
  "input.frequency.status": "descInputFrequencyStatus",
  "input.load": "descInputLoad",
  "input.phase.shift": "descInputPhaseShift",
  "input.phases": "descInputPhases",
  "input.power": "descInputPower",
  "input.quality": "descInputQuality",
  "input.realpower": "descInputRealpower",
  "input.realpower.nominal": "descInputRealpowerNominal",
  "input.sensitivity": "descInputSensitivity",
  "input.source": "descInputSource",
  "input.source.preferred": "descInputSourcePreferred",
  "input.transfer.boost.high": "descInputTransferBoostHigh",
  "input.transfer.boost.low": "descInputTransferBoostLow",
  "input.transfer.bypass.forced": "descInputTransferBypassForced",
  "input.transfer.bypass.high": "descInputTransferBypassHigh",
  "input.transfer.bypass.low": "descInputTransferBypassLow",
  "input.transfer.bypass.outlimits": "descInputTransferBypassOutlimits",
  "input.transfer.bypass.overload": "descInputTransferBypassOverload",
  "input.transfer.delay": "descInputTransferDelay",
  "input.transfer.eco.high": "descInputTransferEcoHigh",
  "input.transfer.eco.low": "descInputTransferEcoLow",
  "input.transfer.frequency.bypass.range": "descInputTransferFrequencyBypassRange",
  "input.transfer.frequency.eco.range": "descInputTransferFrequencyEcoRange",
  "input.transfer.high": "descInputTransferHigh",
  "input.transfer.high.max": "descInputTransferHighMax",
  "input.transfer.high.min": "descInputTransferHighMin",
  "input.transfer.hysteresis": "descInputTransferHysteresis",
  "input.transfer.low": "descInputTransferLow",
  "input.transfer.low.max": "descInputTransferLowMax",
  "input.transfer.low.min": "descInputTransferLowMin",
  "input.transfer.reason": "descInputTransferReason",
  "input.transfer.trim.high": "descInputTransferTrimHigh",
  "input.transfer.trim.low": "descInputTransferTrimLow",
  "input.voltage": "descInputVoltage",
  "input.voltage.extended": "descInputVoltageExtended",
  "input.voltage.high.critical": "descInputVoltageHighCritical",
  "input.voltage.high.warning": "descInputVoltageHighWarning",
  "input.voltage.low.critical": "descInputVoltageLowCritical",
  "input.voltage.low.warning": "descInputVoltageLowWarning",
  "input.voltage.maximum": "descInputVoltageMaximum",
  "input.voltage.minimum": "descInputVoltageMinimum",
  "input.voltage.nominal": "descInputVoltageNominal",
  "input.voltage.status": "descInputVoltageStatus",
  "outlet.count": "descOutletCount",
  "outlet.current": "descOutletCurrent",
  "outlet.delay.shutdown": "descOutletDelayShutdown",
  "outlet.desc": "descOutletDesc",
  "outlet.group.id": "descOutletGroupId",
  "outlet.group.status": "descOutletGroupStatus",
  "outlet.group.type": "descOutletGroupType",
  "outlet.id": "descOutletId",
  "outlet.status": "descOutletStatus",
  "outlet.switchable": "descOutletSwitchable",
  "output.current": "descOutputCurrent",
  "output.current.nominal": "descOutputCurrentNominal",
  "output.frequency": "descOutputFrequency",
  "output.frequency.nominal": "descOutputFrequencyNominal",
  "output.inverter.latency": "descOutputInverterLatency",
  "output.phases": "descOutputPhases",
  "output.power": "descOutputPower",
  "output.voltage": "descOutputVoltage",
  "output.voltage.nominal": "descOutputVoltageNominal",
  "power.maximum": "descPowerMaximum",
  "power.maximum.percent": "descPowerMaximumPercent",
  "power.minimum": "descPowerMinimum",
  "power.minimum.percent": "descPowerMinimumPercent",
  "power.percent": "descPowerPercent",
  "ups.alarm": "descUpsAlarm",
  "ups.beeper.status": "descUpsBeeperStatus",
  "ups.contacts": "descUpsContacts",
  "ups.date": "descUpsDate",
  "ups.delay.reboot": "descUpsDelayReboot",
  "ups.delay.shutdown": "descUpsDelayShutdown",
  "ups.delay.start": "descUpsDelayStart",
  "ups.display.language": "descUpsDisplayLanguage",
  "ups.efficiency": "descUpsEfficiency",
  "ups.id": "descUpsId",
  "ups.load": "descUpsLoad",
  "ups.load.high": "descUpsLoadHigh",
  "ups.mode": "descUpsMode",
  "ups.power": "descUpsPower",
  "ups.power.nominal": "descUpsPowerNominal",
  "ups.productid": "descUpsProductid",
  "ups.realpower": "descUpsRealpower",
  "ups.realpower.nominal": "descUpsRealpowerNominal",
  "ups.shutdown": "descUpsShutdown",
  "ups.start.auto": "descUpsStartAuto",
  "ups.start.battery": "descUpsStartBattery",
  "ups.start.reboot": "descUpsStartReboot",
  "ups.status": "descUpsStatus",
  "ups.temperature": "descUpsTemperature",
  "ups.test.date": "descUpsTestDate",
  "ups.test.interval": "descUpsTestInterval",
  "ups.test.result": "descUpsTestResult",
  "ups.time": "descUpsTime",
  "ups.timer.reboot": "descUpsTimerReboot",
  "ups.timer.shutdown": "descUpsTimerShutdown",
  "ups.timer.start": "descUpsTimerStart",
  "ups.type": "descUpsType",
  "ups.vendorid": "descUpsVendorid",
  "ups.watchdog.status": "descUpsWatchdogStatus",
  "voltage.high.critical": "descVoltageHighCritical",
  "voltage.high.warning": "descVoltageHighWarning",
  "voltage.low.critical": "descVoltageLowCritical",
  "voltage.low.warning": "descVoltageLowWarning",
  "voltage.maximum": "descVoltageMaximum",
  "voltage.minimum": "descVoltageMinimum",
  "voltage.nominal": "descVoltageNominal",
  "voltage.status": "descVoltageStatus",
};

/** Explanations for the channels — what kind of readings live below them. */
const CHANNEL_DESC_I18N: Record<string, I18nKey> = {
  battery: "descChannelBattery",
  device: "descChannelDevice",
  driver: "descChannelDriver",
  input: "descChannelInput",
  output: "descChannelOutput",
  ups: "descChannelUps",
  outlet: "descChannelOutlet",
  ambient: "descChannelAmbient",
  status: "descChannelStatus",
  commands: "descChannelCommands",
  info: "descChannelUpsInfo",
};

/**
 * The explanation for a NUT variable, or undefined when the name says it all. Same
 * base-name collapse as {@link varTranslation} so three-phase and multi-sensor variants
 * reuse the explanation of their base variable.
 *
 * @param nutVarName NUT variable name
 */
function varDescription(nutVarName: string): LocalizedName | undefined {
  const key = VAR_DESC_I18N[nutVarName];
  if (key) {
    return tDesc(key);
  }
  const generic = genericVariantOf(nutVarName);
  const genericKey = generic ? VAR_DESC_I18N[generic] : undefined;
  return genericKey ? tDesc(genericKey) : undefined;
}

/** Severity level → its label key (0 = OK … 4 = emergency). */
const SEVERITY_I18N: I18nKey[] = ["sev0", "sev1", "sev2", "sev3", "sev4"];

/**
 * Translate the labels of a value list; a value without a catalog entry keeps the server's own
 * token as its label.
 *
 * @param states The value list as detected from the NUT variable
 */
function localizeStates(states: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!states) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [value, fallback] of Object.entries(states)) {
    const key = VALUE_I18N[value];
    out[value] = key ? tText(key) : fallback;
  }
  return out;
}

/** LIST UPS says this when the NUT server has no `desc` configured for a UPS in ups.conf. */
const NO_DESCRIPTION = "Description unavailable";

/** Manages creation, update and cleanup of ioBroker objects and states for NUT UPS devices. */
export class StateManager {
  private readonly adapter: utils.AdapterInstance;
  private readonly createdIds = new Set<string>();
  /** NUT variables already warned about as a value that does not fit its field (warn once). */
  private readonly warnedGarbageVars = new Set<string>();
  /**
   * stateId → the `common.type` the object was actually created with in THIS runtime.
   *
   * `ensureState` writes an object once per runtime (createdIds), so a variable whose detected
   * type changes between two polls would otherwise get the new value written into the old object:
   * a string in a `type: "boolean"` datapoint, standing until the next adapter restart. Design #16
   * forbids re-typing the object, so the VALUE has to yield instead — and to decide that, the type
   * the object carries has to be known.
   */
  private readonly createdTypes = new Map<string, ioBroker.CommonType>();
  /** Last device name derived from mfr+model per UPS — lets a transient/wrong fallback self-correct. */
  private readonly fallbackNames = new Map<string, string>();
  /** Recording configurations of renamed datapoints whose successor is created later in this run. */
  private readonly pendingRecording = new Map<string, Record<string, unknown>>();
  /**
   * stateId → original NUT variable/command name. The dot→dash id mapping is lossy for names
   * containing a literal dash (three-phase input.L1-L2.*), so onStateChange reads the real name
   * back from here instead of reversing the id.
   */
  private readonly nutNames = new Map<string, string>();

  /**
   * @param adapter The ioBroker adapter instance
   */
  constructor(adapter: utils.AdapterInstance) {
    this.adapter = adapter;
  }

  /**
   * Re-apply the adapter's own manifest objects to an EXISTING installation.
   *
   * js-controller does refresh `common.desc` of an `instanceObjects` entry on every start — but
   * it does so with `preserve: { common: ["name"], native: true }` (measured in
   * `@iobroker/js-controller-adapter` 7.2.2, `_extendObjects`). The NAME is therefore frozen at
   * whatever the version that first created the object wrote: a rename in the manifest reaches
   * fresh installs only, and nothing — not the manifest, not a gate, not a test — would show it.
   * Only the live tree of an updated system would.
   *
   * The six ids are written out one by one on purpose rather than looped over the manifest: the
   * fleet gate matches the literal id at the `extendObject` call, and a loop would be DRYer but
   * unverifiable (`reference_gate_braucht_die_woertliche_kennung`).
   */
  async refreshInstanceObjects(): Promise<void> {
    await this.adapter.extendObject("info", {
      common: { name: tName("channelInfo"), desc: tDesc("descChannelInfo") },
    });
    await this.adapter.extendObject("info.connection", {
      common: { name: tName("connectionStatus"), desc: tDesc("descConnectionStatus") },
    });
    await this.adapter.extendObject("info.upsTotal", {
      common: { name: tName("upsCountTotal"), desc: tDesc("descUpsCountTotal") },
    });
    await this.adapter.extendObject("info.upsReachable", {
      common: { name: tName("upsCountReachable"), desc: tDesc("descUpsCountReachable") },
    });
    await this.adapter.extendObject("info.allUpsReachable", {
      common: { name: tName("upsAllReachable"), desc: tDesc("descUpsAllReachable") },
    });
    await this.adapter.extendObject("notify", {
      common: { name: tName("notifyTrigger"), desc: tDesc("descNotifyTrigger") },
    });
  }

  /**
   * Create device + standard channels for a discovered UPS.
   *
   * @param upsName NUT UPS identifier (e.g. "ups0")
   * @param description UPS description from LIST UPS
   */
  async ensureUpsDevice(upsName: string, description: string): Promise<void> {
    this.adapter.log.debug(`ensureUpsDevice: ${upsName} desc='${description}'`);
    // The server's own text, wrapped as a translation object like every other name (core-team
    // line, #15). Without a `desc` in ups.conf the server answers a placeholder — the UPS name
    // is the better label then, and the first poll replaces it with manufacturer + model.
    const label = description && description !== NO_DESCRIPTION ? description : upsName;
    await this.adapter.extendObject(
      upsName,
      {
        type: "device",
        common: {
          name: tRaw(label),
          statusStates: {
            onlineId: `${this.adapter.namespace}.${upsName}.info.reachable`,
          },
        },
        native: {},
      },
      // No `preserve` for the name: the adapter owns common.name/desc like it owns type and
      // role (krobi 2026-09-02 — a user's place is 0_userdata, not an adapter's datapoints).
      // The recording configuration is the explicit exception and stays untouched: merging
      // never removes what it does not carry (reference_iobroker_objekt_aendern_ohne_loeschen).
    );
    this.createdIds.add(upsName);

    await this.ensureChannel(upsName, "info");

    await this.ensureState(`${upsName}.info.reachable`, {
      type: "boolean",
      role: "indicator.reachable",
      read: true,
      write: false,
      name: tName("upsReachable"),
      desc: tDesc("descUpsReachable"),
      def: false,
    });

    // Last upsmon event routed to this UPS through the `notify` trigger state. Lives under the
    // adapter-owned info channel: a dotless NUT variable lands directly under the device, so any
    // leaf there could one day collide with a real variable name — info never can.
    await this.ensureState(`${upsName}.info.notify`, {
      type: "string",
      role: "text",
      read: true,
      write: false,
      name: tName("upsLastNotify"),
      desc: tDesc("descUpsLastNotify"),
    });

    await this.cleanupDeprecatedInfoStates(upsName);
  }

  /**
   * Update device common.name from LIST VAR data when LIST UPS description is unusable.
   *
   * The adapter owns the name: the derived one is written whenever it differs from the one
   * this adapter wrote last (memory-guarded, so a steady poll costs no broker round-trip).
   * A rename in the object tree is reset on the next sync — that is the fleet line since
   * 2026-09-02, not an oversight. `preserve: common.name` would additionally never apply
   * here, since the device object always carries a name (v0.2.5-v0.4.1 lost the fallback
   * that way).
   *
   * @param upsName UPS identifier
   * @param description UPS description from LIST UPS
   * @param variables Variables from LIST VAR
   */
  async updateDeviceName(
    upsName: string,
    description: string,
    variables: Array<{ name: string; value: string }>,
  ): Promise<void> {
    if (description && description !== NO_DESCRIPTION) {
      return;
    }
    const mfr = variables.find(v => v.name === "device.mfr")?.value?.trim();
    const model = variables.find(v => v.name === "device.model")?.value?.trim();
    if (!mfr && !model) {
      return;
    }
    const name = [mfr, model].filter(Boolean).join(" ");
    // Already applied this exact fallback name → no broker round-trip on steady-state polls.
    if (this.fallbackNames.get(upsName) === name) {
      return;
    }

    this.adapter.log.debug(`updateDeviceName ${upsName}: using fallback '${name}' (mfr+model)`);
    await this.adapter.extendObject(upsName, { common: { name: tRaw(name) } });
    this.fallbackNames.set(upsName, name);
  }

  /**
   * Ensure a channel exists for a NUT domain (e.g. "battery", "ups").
   *
   * @param upsName UPS identifier
   * @param channelName Channel name (NUT domain)
   */
  async ensureChannel(upsName: string, channelName: string): Promise<void> {
    const id = `${upsName}.${channelName}`;
    const i18nKey = CHANNEL_I18N[channelName];
    const name: LocalizedName = i18nKey ? tName(i18nKey) : tRaw(channelName);
    const descKey = CHANNEL_DESC_I18N[channelName];

    await this.ensureObject(id, {
      type: "channel",
      common: descKey ? { name, desc: tDesc(descKey) } : { name },
      native: {},
    });
  }

  /**
   * Update variables from LIST VAR, creating states as needed.
   * Variables are processed sorted by dot-depth (shallow first) to ensure
   * parent states exist before children.
   *
   * @param upsName UPS identifier
   * @param variables Variables from LIST VAR
   * @param rwNames Set of writable variable names from LIST RW
   */
  async updateVariables(upsName: string, variables: NutVariable[], rwNames: Set<string>): Promise<void> {
    this.adapter.log.debug(`updateVariables ${upsName}: ${variables.length} vars, ${rwNames.size} writable`);
    const sorted = [...variables].sort((a, b) => {
      const depthA = a.name.split(".").length;
      const depthB = b.name.split(".").length;
      return depthA - depthB;
    });

    // Every id that is going to be a CHANNEL in this run: the adapter's own three plus the first
    // segment of every dotted variable. A dotless variable carrying one of those names would be
    // created as a state under exactly that id — and because both creations short-circuit on the
    // same `createdIds` cache, whichever ran first wins and the other one's children end up
    // hanging under the wrong kind of object. Dotless names sort first (depth 1), so without this
    // set the state would always be the one to win.
    const channelIds = new Set<string>(ADAPTER_OWNED_CHANNELS);
    for (const v of variables) {
      const dot = v.name.indexOf(".");
      if (dot >= 0) {
        channelIds.add(v.name.slice(0, dot));
      }
    }

    for (const v of sorted) {
      // A NUT variable without a dot has no channel segment and is created directly under the
      // device. NUT 2.8.5 itself never emits one — all 321 literal `dstate_setinfo` names carry a
      // dot, and the `ALARM` this comment used to cite is a VALUE of ups.status (drivers/dstate.c:
      // `dstate_setinfo("ups.status", "ALARM")`), not a variable. The branch exists for the other
      // servers that speak this protocol (NAS firmware, home-grown upsd), which may send anything.
      const firstDot = v.name.indexOf(".");
      if (firstDot >= 0) {
        await this.ensureChannel(upsName, v.name.slice(0, firstDot));
      } else if (channelIds.has(v.name)) {
        // …and such a name must never collide with a channel id: the state object would take
        // that id, and everything belonging under the channel would end up hanging beneath a
        // state. Skip it and say so once — the alternative is a structurally broken tree.
        const warnKey = `${upsName}.${v.name}`;
        if (!this.warnedGarbageVars.has(warnKey)) {
          this.warnedGarbageVars.add(warnKey);
          this.adapter.log.warn(
            `Ignoring NUT variable '${v.name}' on ${upsName}: a channel of that name exists in the object tree`,
          );
        }
        continue;
      }

      const isWritable = rwNames.has(v.name);
      const detected = detectType(v.name, v.value, isWritable);

      // Garbage value in a numeric field (e.g. "Infinity", "12abc") → discard
      // instead of storing junk, and warn once per variable (no log spam).
      if (detected.expectedNumeric) {
        // Keyed per UPS, not per variable name: the warning names the UPS, so a second UPS
        // reporting the same junk has to be able to say so once as well.
        this.warnValueMismatch(upsName, v.name, `non-numeric value ${JSON.stringify(v.value)} for a numeric variable`);
        continue;
      }

      const stateId = nutVarToStateId(upsName, v.name);
      this.nutNames.set(stateId, v.name);
      const states = localizeStates(detectStates(v.name));
      const effectiveType = await this.ensureState(stateId, {
        type: detected.type,
        role: detected.role,
        unit: detected.unit,
        read: detected.read,
        write: detected.write,
        name: varTranslation(v.name) ?? tRaw(nutVarToReadableName(v.name)),
        desc: varDescription(v.name),
        states,
      });

      // The object is written once per runtime (design #16 forbids re-typing it between polls),
      // so a value whose detected type has drifted away from it must NOT be stored: it would sit
      // in the datapoint as a string in a boolean field until the next restart, breaking every
      // script that trusts the declared type. `expectedNumeric` only ever caught the variables
      // detectUnit knows; this covers the rest, including driver.flag.* going boolean → string.
      // null stays allowed — it is "no value" for every type (an idle countdown writes it).
      if (detected.parsedValue !== null && typeof detected.parsedValue !== effectiveType) {
        this.warnValueMismatch(
          upsName,
          v.name,
          `value ${JSON.stringify(v.value)} is a ${typeof detected.parsedValue}, but the data point is a ${effectiveType} (restart the adapter to re-type it)`,
        );
        continue;
      }

      await this.adapter.setStateChangedAsync(stateId, { val: detected.parsedValue, ack: true });
    }
  }

  /**
   * Complain once per UPS and variable that a value cannot be stored, then stay quiet.
   *
   * Keyed per UPS, not per variable name: the message names the UPS, so a second UPS reporting the
   * same trouble has to be able to say so once as well.
   *
   * @param upsName UPS identifier
   * @param varName NUT variable name
   * @param what What is wrong with the value
   */
  private warnValueMismatch(upsName: string, varName: string, what: string): void {
    const warnKey = `${upsName}.${varName}`;
    if (this.warnedGarbageVars.has(warnKey)) {
      return;
    }
    this.warnedGarbageVars.add(warnKey);
    this.adapter.log.warn(`Discarding ${what} — variable '${varName}' on ${upsName}`);
  }

  /**
   * Parse ups.status and update status channel with individual boolean flags + severity.
   *
   * @param upsName UPS identifier
   * @param rawStatus Raw ups.status value
   * @param chargerStatus Optional battery.charger.status (modern source for charging/discharging)
   */
  async updateStatusFlags(upsName: string, rawStatus: string, chargerStatus?: string): Promise<void> {
    await this.ensureChannel(upsName, "status");

    const result = parseStatus(rawStatus, chargerStatus);
    const activeFlags = ALL_FLAG_KEYS.filter(k => result.flags[k]).join(", ") || "none";
    this.adapter.log.debug(
      `updateStatusFlags ${upsName}: raw='${rawStatus}' severity=${result.severity} active=[${activeFlags}]`,
    );

    await this.ensureAndSet(
      `${upsName}.status.raw`,
      {
        type: "string",
        role: "text",
        read: true,
        write: false,
        name: tName("statusRaw"),
        desc: tDesc("descStatusRaw"),
      },
      result.raw,
    );

    await this.ensureAndSet(
      `${upsName}.status.severity`,
      {
        type: "number",
        role: "value.severity",
        read: true,
        write: false,
        name: tName("statusSeverity"),
        desc: tDesc("descStatusSeverity"),
        states: Object.fromEntries(SEVERITY_I18N.map((key, level) => [level, tText(key)])),
      },
      result.severity,
    );

    await this.ensureAndSet(
      `${upsName}.status.display`,
      {
        type: "string",
        role: "text",
        read: true,
        write: false,
        name: tName("statusDisplay"),
        desc: tDesc("descStatusDisplay"),
      },
      getDisplayEntries(rawStatus)
        .map(entry => (entry.i18nKey ? tText(entry.i18nKey) : entry.token))
        .join(", "),
    );

    for (const flagKey of ALL_FLAG_KEYS) {
      const meta = FLAG_META[flagKey];
      await this.ensureAndSet(
        `${upsName}.status.${flagKey}`,
        {
          type: "boolean",
          role: meta?.role ?? "indicator",
          read: true,
          write: false,
          name: meta ? tName(meta.i18nKey) : tRaw(flagKey),
          desc: meta ? tDesc(meta.descKey) : undefined,
        },
        result.flags[flagKey],
      );
    }
  }

  /**
   * Create button states for instant commands.
   *
   * @param upsName UPS identifier
   * @param commands Commands from LIST CMD
   */
  async createCommandButtons(upsName: string, commands: NutCommand[]): Promise<void> {
    await this.ensureChannel(upsName, "commands");

    for (const cmd of commands) {
      const stateId = `${upsName}.commands.${cmd.name.replace(/\./g, "-")}`;
      this.nutNames.set(stateId, cmd.name);
      const entry = commandCatalogEntry(cmd.name);
      await this.ensureState(stateId, {
        type: "boolean",
        role: "button",
        read: false,
        write: true,
        name: entry
          ? withVariantMarker(tName(entry.key), entry.markers)
          : tRaw(cmd.name.replace(/\./g, " ").replace(/^./, c => c.toUpperCase())),
        // Every command the catalog knows gets its explanation; an unmapped one keeps none —
        // the adapter cannot know what a driver-private command does.
        desc: entry ? tDesc(descKeyOf(entry.key)) : undefined,
        def: false,
      });
    }
  }

  /**
   * The original NUT variable/command name for a created state id. onStateChange uses it instead
   * of reversing the dot→dash id mapping, which is lossy for names carrying a literal dash
   * (e.g. three-phase input.L1-L2.voltage). Undefined for states not backed by a NUT var/command.
   *
   * @param stateId Local state id (e.g. "ups0.input.L1-L2-voltage")
   */
  nutNameForState(stateId: string): string | undefined {
    return this.nutNames.get(stateId);
  }

  /**
   * Reset `info.reachable` to false for every UPS device already in the object tree.
   *
   * ioBroker keeps the last value of a state forever, and the device object points its
   * `statusStates.onlineId` at this one — so a UPS keeps showing "online" across an adapter
   * restart until the first successful poll overwrites it. That window is unbounded whenever
   * the NUT server cannot be reached: the poll timer is only armed after a connect, so with
   * the server down nothing ever writes the state and the stale `true` stands indefinitely.
   * Called at startup, before the first connect attempt: not-yet-read is honestly "not
   * reachable", which is what the state's own default (`def: false`) already declares.
   */
  async markAllUnreachable(): Promise<void> {
    const adapterObjects = await this.adapter.getAdapterObjectsAsync();
    const localIds = new Set(Object.keys(adapterObjects).map(id => id.replace(`${this.adapter.namespace}.`, "")));

    for (const [id, obj] of Object.entries(adapterObjects)) {
      if (obj.type !== "device") {
        continue;
      }
      const reachableId = `${id.replace(`${this.adapter.namespace}.`, "")}.info.reachable`;
      // A device from an older object layout may not carry the state — writing it would create
      // a value without an object behind it.
      if (!localIds.has(reachableId)) {
        continue;
      }
      await this.adapter.setStateChangedAsync(reachableId, { val: false, ack: true });
    }
    // The summary makes the same claim one level up — "2 of 2 reachable" while nothing is
    // being read is the identical lie. `info.upsTotal` stays: how many UPSes exist did not
    // change just because nobody is asking them.
    await this.adapter.setStateChangedAsync("info.upsReachable", { val: 0, ack: true });
    await this.adapter.setStateChangedAsync("info.allUpsReachable", { val: false, ack: true });
  }

  /**
   * Write the fleet summary: how many UPS devices the NUT server reports and how many of them
   * answered this poll. `allUpsReachable` is the one line an automation can watch instead of
   * checking every device — deliberately false while nothing was found at all, because "0 of 0"
   * is not "everything is fine".
   *
   * The three states are static instance objects, so they exist from installation on and need
   * no create-on-first-write.
   *
   * @param total UPS devices currently discovered on the NUT server
   * @param reachable How many of them answered this poll
   */
  async writeUpsSummary(total: number, reachable: number): Promise<void> {
    await this.adapter.setStateChangedAsync("info.upsTotal", { val: total, ack: true });
    await this.adapter.setStateChangedAsync("info.upsReachable", { val: reachable, ack: true });
    await this.adapter.setStateChangedAsync("info.allUpsReachable", {
      val: total > 0 && reachable === total,
      ack: true,
    });
  }

  /**
   * Bring the object tree in line with what the NUT server currently reports: drop devices for
   * UPSes that are gone, drop orphaned roots left by earlier versions, and move the v0.1.0
   * dot-style objects onto their current ids.
   *
   * ONE read of the adapter namespace for all three passes. They used to be two public methods
   * with a `getAdapterObjectsAsync()` each, called back to back — and since design #25 that runs
   * on every (re)connect and every change of the UPS list, not once per adapter start.
   *
   * The order matters and is the reason this is a single method rather than a shared snapshot
   * handed to two: the device pass deletes objects, so the later passes must not judge the same
   * snapshot again — a removed UPS would be reported a second time, as an "orphan from a previous
   * adapter version", which is the wrong sentence for a UPS the user just unplugged.
   *
   * @param knownUpsNames Sanitized object-ID segments of the currently discovered UPSes
   */
  async pruneObjectTree(knownUpsNames: Set<string>): Promise<void> {
    const adapterObjects = await this.adapter.getAdapterObjectsAsync();
    const local = (fullId: string): string => fullId.replace(`${this.adapter.namespace}.`, "");

    // Pass 1 — devices of UPSes the server no longer lists.
    const staleDevices = new Set<string>();
    for (const [fullId, obj] of Object.entries(adapterObjects)) {
      if (obj.type === "device" && !knownUpsNames.has(local(fullId))) {
        staleDevices.add(local(fullId));
      }
    }
    for (const deviceId of staleDevices) {
      this.adapter.log.info(`Removing stale UPS device: ${deviceId}`);
      await this.adapter.delObjectAsync(deviceId, { recursive: true });
      this.dropCacheUnder(deviceId);
    }

    // Pass 2/3 — orphaned roots and v0.1.0 dot-style ids, on the same snapshot but skipping
    // everything pass 1 has already taken out (recursively, so children go with their device).
    const removed = (localId: string): boolean =>
      [...staleDevices].some(d => localId === d || localId.startsWith(`${d}.`));

    const orphanRoots = new Set<string>();
    const dotStyleIds: string[] = [];
    for (const fullId of Object.keys(adapterObjects)) {
      const localId = local(fullId);
      if (removed(localId)) {
        continue;
      }
      const parts = localId.split(".");
      const topLevel = parts[0];

      // Adapter-owned roots that are NOT UPS devices: the info channel and the notify trigger
      // state. Without the exemption the orphan sweep would eat them on every discover.
      if (topLevel === "info" || topLevel === "notify") {
        continue;
      }

      if (!knownUpsNames.has(topLevel)) {
        orphanRoots.add(topLevel);
        continue;
      }

      if (parts.length > 3) {
        dotStyleIds.push(localId);
      }
    }

    for (const root of orphanRoots) {
      this.adapter.log.info(`Removing orphaned root object from previous adapter version: ${root}`);
      await this.adapter.delObjectAsync(root, { recursive: true });
      this.dropCacheUnder(root);
    }

    const sorted = dotStyleIds.sort((a, b) => b.split(".").length - a.split(".").length);
    for (const id of sorted) {
      // The v0.1.0 id is the SAME datapoint under an older scheme (ups0.battery.charge.low →
      // ups0.battery.charge-low), so this is a move, not a removal: the user's recording goes
      // with it. Only a leaf carries one; a parent that merely holds children has none.
      const parts = id.split(".");
      const successor = `${parts[0]}.${parts[1]}.${parts.slice(2).join("-")}`;
      await this.carryRecordingFrom(adapterObjects[`${this.adapter.namespace}.${id}`], successor);
      this.adapter.log.debug(`Removing v0.1.0 dot-style object: ${id}`);
      await this.adapter.delObjectAsync(id);
      this.createdIds.delete(id);
    }
  }

  private async cleanupDeprecatedInfoStates(upsName: string): Promise<void> {
    // Once per runtime per UPS — these states are gone after the first connect, so re-running
    // the delObject calls on every reconnect is wasted work. Cache-keyed like the name fallback;
    // cleared together with the device in pruneObjectTree, so a re-added UPS cleans up again.
    const cacheKey = `${upsName}.__deprecatedCleanup`;
    if (this.createdIds.has(cacheKey)) {
      return;
    }
    this.createdIds.add(cacheKey);
    // Two of these are RENAMES — the datapoint lives on under a new id, so the user's
    // recording moves with it before the old object goes (the successors already exist:
    // ensureUpsDevice creates info.reachable above, the status flags come with the first poll).
    const renamed: Record<string, string> = {
      // 0.4.0: the old `online` leaf collided with the status.online / OL flag.
      [`${upsName}.info.online`]: `${upsName}.info.reachable`,
      // 0.6.0: the non-standard flag name was replaced by the real ECO token.
      [`${upsName}.status.highEfficiency`]: `${upsName}.status.ecoMode`,
    };
    // Dropped for good — not real NUT status_set tokens (COMM/NOCOMM), or never a datapoint of
    // ours. NB: `testing` is NOT here — TEST is a real token (apc_modbus, powercom, …) and is a
    // current flag again. Without the delete the old state lingers frozen at its last value —
    // ioBroker does not auto-remove states an adapter stops writing.
    const dropped = [
      `${upsName}.info.name`,
      `${upsName}.info.description`,
      `${upsName}.status.commEstablished`,
      `${upsName}.status.commLost`,
    ];
    for (const id of [...Object.keys(renamed), ...dropped]) {
      try {
        const successor = renamed[id];
        if (successor) {
          await this.carryRecording(id, successor);
        }
        await this.adapter.delObjectAsync(id);
        this.adapter.log.debug(`Removed deprecated state: ${id}`);
      } catch {
        // Object doesn't exist — nothing to clean up
      }
    }
  }

  /**
   * Remove every cached memory of a UPS whose objects have just been deleted.
   *
   * ALL of them, not only the object-id caches: a UPS can come back within the same runtime since
   * design #25 (the poll re-reads LIST UPS, so a device added or removed on the NUT server appears
   * or disappears without a reconnect). A leftover `fallbackNames` entry then makes
   * `updateDeviceName` believe it already wrote that name — the re-created device keeps the bare
   * UPS name and never gets "manufacturer + model" back until the adapter restarts. The other two
   * are the same class, one step smaller: a stale `pendingRecording` entry would hand a dead
   * predecessor's recording to a fresh state, and a stale `warnedGarbageVars` entry would swallow
   * the first garbage-value warning of the returning UPS.
   *
   * @param prefix UPS object-ID segment whose cached state is dropped
   */
  private dropCacheUnder(prefix: string): void {
    const under = (id: string): boolean => id === prefix || id.startsWith(`${prefix}.`);
    for (const id of [...this.createdIds]) {
      if (under(id)) {
        this.createdIds.delete(id);
      }
    }
    for (const id of [...this.nutNames.keys()]) {
      if (under(id)) {
        this.nutNames.delete(id);
      }
    }
    for (const id of [...this.createdTypes.keys()]) {
      if (under(id)) {
        this.createdTypes.delete(id);
      }
    }
    for (const id of [...this.pendingRecording.keys()]) {
      if (under(id)) {
        this.pendingRecording.delete(id);
      }
    }
    for (const key of [...this.warnedGarbageVars]) {
      if (under(key)) {
        this.warnedGarbageVars.delete(key);
      }
    }
    this.fallbackNames.delete(prefix);
  }

  private async ensureObject(
    id: string,
    obj: {
      type: "device" | "channel" | "folder";
      common: Partial<ioBroker.ObjectCommon>;
      native: Record<string, unknown>;
    },
  ): Promise<void> {
    if (this.createdIds.has(id)) {
      return;
    }
    // extendObject, not setObjectNotExists: a channel created by an older version keeps whatever
    // name that version wrote, and "create if missing" would never correct it — the adapter owns
    // the name (design #31), so it has to reach EXISTING trees too. Once per runtime per id
    // (createdIds), so a steady poll costs no extra write.
    await this.adapter.extendObject(id, {
      type: obj.type,
      common: obj.common as ioBroker.ObjectCommon,
      native: obj.native,
    });
    this.createdIds.add(id);
  }

  /**
   * Create the state object once per runtime and report the `common.type` that is in force for it.
   *
   * @param id State id
   * @param common Object definition
   * @param common.type ioBroker state type
   * @param common.role ioBroker state role
   * @param common.read Whether the state is readable
   * @param common.write Whether the state is writable
   * @param common.name Localized name
   * @param common.desc Short explanation; omitted where the name already says everything
   * @param common.unit Unit of the value
   * @param common.def Default value
   * @param common.states Value list for an enum datapoint
   * @returns the type the object carries — the one already created, or the one just written
   */
  private async ensureState(
    id: string,
    common: {
      type: ioBroker.CommonType;
      role: string;
      read: boolean;
      write: boolean;
      name: LocalizedName;
      /** Short explanation; omitted where the name already says everything. */
      desc?: LocalizedName;
      unit?: string;
      def?: boolean;
      states?: Record<string, string>;
    },
  ): Promise<ioBroker.CommonType> {
    if (this.createdIds.has(id)) {
      return this.createdTypes.get(id) ?? common.type;
    }
    // First contact with this object in this runtime: take away what a merge could never remove
    // later (a shrunk value list, bounds from a RANGE that no longer exists), then write the
    // current picture on top. The enrichment that may re-add bounds runs after this, in the same
    // poll — so a bound never outlives the LIST RANGE that produced it.
    await this.clearShrinkableFields(id, common.states !== undefined);
    await this.adapter.extendObject(id, {
      type: "state",
      common,
      native: {},
    });
    this.createdIds.add(id);
    this.createdTypes.set(id, common.type);
    await this.applyCarriedRecording(id);
    return common.type;
  }

  /**
   * Erase the fields of an EXISTING object that a later merge could never take away again, so the
   * write that follows starts from a clean slate.
   *
   * `extendObject` merges key by key: a key the new picture does not carry SURVIVES, forever.
   * Two kinds of field suffer from that and both are cleared here, in ONE read of the object:
   *
   * - `common.states` can SHRINK between adapter versions or driver updates — a dropped entry
   *   would linger in the dropdown and stay selectable.
   * - `common.min`/`max` come from LIST RANGE alone. Once written they outlived the driver that
   *   reported them: through restarts, and forever once the variable stopped being writable. The
   *   consequence is not cosmetic — js-controller warns on every value outside the dead bounds.
   *
   * `null` is what erases a key (node.extend copies null, skips undefined). Clearing is skipped
   * entirely when the object carries none of them, so a steady poll costs no extra write.
   *
   * @param id State object id
   * @param clearStates Whether the caller is about to write a fresh `common.states`
   */
  private async clearShrinkableFields(id: string, clearStates: boolean): Promise<void> {
    await this.removeCommonFields(id, clearStates ? ["states", "min", "max"] : ["min", "max"]);
  }

  /**
   * Really REMOVE attributes from an existing object's `common` — key and all.
   *
   * `extendObject` cannot do this. It merges, and `node.extend` COPIES a `null` instead of
   * dropping the key: the attribute then survives with the value `null`, which is not the same as
   * gone. For `common.supportedMessages` that is good enough (js-controller reads `null` as "not
   * set"), but for a state's own attributes it is a defect the object-structure checker names
   * outright — `common.min` must be of type number, `common.states` must be of type object, and
   * `null` is neither (E1004). Measured on the first inventory run this gate ever did for nut2:
   * 15 findings, all of them from writing `null`.
   *
   * So the whole object is read, the attributes are deleted from a copy, and the copy is put back
   * through `delObject` → `setObjectNotExists` — the ioBroker-native full replace. `setObject`
   * would do the same in one step but is on the checker's deprecated list (S5054), and an entry in
   * the exception register is not a fix. What goes back is the REAL object minus exactly those
   * keys, so type, role, name, native and the user's recording (`common.custom`) all travel along;
   * a repair of adapter-owned metadata must never cost the user their charts (design #31).
   *
   * Two consequences of the delete, both handled here:
   * - `delObject` on a leaf takes the VALUE with it. It is read first and written back afterwards
   *   with `ack: true`, so the round trip is invisible in the tree and `onStateChange` — which
   *   ignores acknowledged writes — does not mistake it for a command.
   * - The pair is not atomic. If the second half fails the datapoint is gone until the next start,
   *   which recreates it; for a repair that runs once per object per runtime that is acceptable,
   *   and it is the trade the fleet already makes (govee-smart, hassemu, homeconnect).
   *
   * @param id State object id
   * @param fields The `common` attributes to remove
   */
  private async removeCommonFields(id: string, fields: string[]): Promise<void> {
    const existing = await this.adapter.getObjectAsync(id);
    if (!existing?.common) {
      return;
    }
    const common = { ...existing.common } as Record<string, unknown>;
    const present = fields.filter(f => common[f] !== undefined && common[f] !== null);
    if (present.length === 0) {
      return;
    }
    for (const f of present) {
      delete common[f];
    }
    const previous = await this.adapter.getStateAsync(id);
    await this.adapter.delObjectAsync(id);
    // The typings cannot express "this object minus a key", hence the cast.
    await this.adapter.setObjectNotExistsAsync(id, { ...existing, common } as unknown as ioBroker.SettableObject);
    if (previous && previous.val !== null && previous.val !== undefined) {
      await this.adapter.setStateChangedAsync(id, { val: previous.val, ack: true });
    }
  }

  /**
   * Move a recording configuration from a renamed predecessor onto the state that replaces it.
   * The adapter owns the datapoint, the user owns the recording — a rename by the adapter must
   * not cost the user their charts.
   *
   * @param fromId The id that is about to disappear
   * @param toId The id that continues the datapoint (may not exist yet)
   */
  private async carryRecording(fromId: string, toId: string): Promise<void> {
    const old = await this.adapter.getObjectAsync(fromId);
    await this.carryRecordingFrom(old, toId);
  }

  /**
   * Same as {@link carryRecording}, for a predecessor already read from the object store.
   *
   * @param old The predecessor object (or null/undefined)
   * @param toId The id that continues the datapoint (may not exist yet)
   */
  private async carryRecordingFrom(old: ioBroker.Object | null | undefined, toId: string): Promise<void> {
    const custom = (old?.common as { custom?: Record<string, unknown> } | undefined)?.custom;
    if (!custom || Object.keys(custom).length === 0) {
      return;
    }
    const target = await this.adapter.getObjectAsync(toId);
    if (!target) {
      // The successor is created later in this run (the first poll builds the variable states)
      // — hand it over then, the predecessor is gone by that point.
      this.pendingRecording.set(toId, custom);
      return;
    }
    await this.adapter.extendObject(toId, { common: { custom } });
    this.adapter.log.info(`Kept the recording settings of the renamed datapoint on ${toId}`);
  }

  /**
   * Apply a recording configuration held back for a state that did not exist yet.
   *
   * @param id The state that has just been created
   */
  private async applyCarriedRecording(id: string): Promise<void> {
    const custom = this.pendingRecording.get(id);
    if (!custom) {
      return;
    }
    this.pendingRecording.delete(id);
    await this.adapter.extendObject(id, { common: { custom } });
    this.adapter.log.info(`Kept the recording settings of the renamed datapoint on ${id}`);
  }

  /**
   * Ensure a state exists (once) and write its current value — the create-then-set pair used for
   * every status/flag datapoint.
   *
   * @param id State id
   * @param common Object definition forwarded to ensureState
   * @param val Value to write (acknowledged)
   */
  private async ensureAndSet(
    id: string,
    common: Parameters<StateManager["ensureState"]>[1],
    val: ioBroker.StateValue,
  ): Promise<void> {
    await this.ensureState(id, common);
    await this.adapter.setStateChangedAsync(id, { val, ack: true });
  }

  /**
   * Enrich an existing state with ENUM/RANGE metadata from the NUT server.
   * Uses extendObject to deep-merge — overwrites only the provided keys.
   *
   * The value labels are translated HERE, not at the call site: a LIST ENUM answer arrives as raw
   * NUT tokens, and this write lands AFTER `updateVariables` has already put the localized catalog
   * labels on the same object — so an untranslated list would quietly undo design #35 for exactly
   * the writable enum datapoints. Translating inside means a future third caller cannot reintroduce
   * that; the values themselves stay the NUT tokens, only their labels follow the system language.
   *
   * @param id State object ID
   * @param patch Metadata to apply (states for ENUM, min/max for RANGE)
   * @param patch.states ENUM value map
   * @param patch.min RANGE minimum
   * @param patch.max RANGE maximum
   */
  async enrichStateMetadata(
    id: string,
    patch: { states?: Record<string, string> | null; min?: number | null; max?: number | null },
  ): Promise<void> {
    this.adapter.log.debug(`enrichStateMetadata ${id}: ${JSON.stringify(patch)}`);
    // `null` means the server no longer reports this attribute — and a merge can only ever ADD,
    // so removal is a separate operation on the whole object (see removeCommonFields).
    const gone = (["states", "min", "max"] as const).filter(f => patch[f] === null);
    if (gone.length > 0) {
      await this.removeCommonFields(id, [...gone]);
    }

    const common: Record<string, unknown> = {};
    if (patch.states) {
      common.states = localizeStates(patch.states);
    }
    if (typeof patch.min === "number") {
      common.min = patch.min;
    }
    if (typeof patch.max === "number") {
      common.max = patch.max;
    }
    if (Object.keys(common).length > 0) {
      if (patch.states) {
        await this.clearShrinkableFields(id, true);
      }
      await this.adapter.extendObject(id, { common });
    }
  }
}
