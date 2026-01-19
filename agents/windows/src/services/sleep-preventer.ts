/**
 * Sleep Prevention Service for Windows
 * Uses SetThreadExecutionState API to prevent system sleep while connected.
 * Screen can still turn off, but the system won't enter sleep/standby mode.
 */

import koffi from 'koffi';

// Windows API constants
const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;
// const ES_DISPLAY_REQUIRED = 0x00000002;  // Uncomment to also prevent display off

let isPreventingEnabled = false;
let kernel32: any = null;
let setThreadExecutionState: any = null;

/**
 * Initialize the Windows API binding
 */
function initializeApi(): boolean {
  if (kernel32) return true;

  try {
    kernel32 = koffi.load('kernel32.dll');
    setThreadExecutionState = kernel32.func('SetThreadExecutionState', 'uint32', ['uint32']);
    return true;
  } catch (err) {
    console.error('Failed to load kernel32.dll:', err);
    return false;
  }
}

/**
 * Enable sleep prevention.
 * The system will not enter sleep mode while this is active.
 * Screen may still turn off based on power settings.
 */
export function enableSleepPrevention(): boolean {
  if (process.platform !== 'win32') {
    console.log('Sleep prevention is only available on Windows');
    return false;
  }

  if (isPreventingEnabled) {
    console.log('Sleep prevention is already enabled');
    return true;
  }

  if (!initializeApi()) {
    return false;
  }

  try {
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED = Keep system awake, allow display off
    const result = setThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
    if (result !== 0) {
      isPreventingEnabled = true;
      console.log('✅ Sleep prevention enabled (system will not sleep while connected)');
      return true;
    } else {
      console.error('SetThreadExecutionState returned 0 (failure)');
      return false;
    }
  } catch (err) {
    console.error('Failed to enable sleep prevention:', err);
    return false;
  }
}

/**
 * Disable sleep prevention.
 * Returns the system to normal power management behavior.
 */
export function disableSleepPrevention(): boolean {
  if (!isPreventingEnabled) {
    return true;
  }

  if (!kernel32 || !setThreadExecutionState) {
    isPreventingEnabled = false;
    return true;
  }

  try {
    // ES_CONTINUOUS alone clears the flags
    const result = setThreadExecutionState(ES_CONTINUOUS);
    isPreventingEnabled = false;
    console.log('💤 Sleep prevention disabled (normal power management restored)');
    return result !== 0;
  } catch (err) {
    console.error('Failed to disable sleep prevention:', err);
    isPreventingEnabled = false;
    return false;
  }
}

/**
 * Check if sleep prevention is currently active
 */
export function isSleepPreventionEnabled(): boolean {
  return isPreventingEnabled;
}
