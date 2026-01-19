/**
 * Sleep Prevention Service for Windows
 * Uses PowerCreateRequest/PowerSetRequest API to prevent Modern Standby.
 * This is more effective than SetThreadExecutionState for S0 Low Power Idle systems.
 */

import koffi from 'koffi';

// Power request types (POWER_REQUEST_TYPE enum)
const PowerRequestDisplayRequired = 0;  // Prevents display from turning off
const PowerRequestSystemRequired = 1;   // Prevents system from entering sleep

// REASON_CONTEXT flags
const POWER_REQUEST_CONTEXT_VERSION = 0;
const POWER_REQUEST_CONTEXT_SIMPLE_STRING = 0x00000001;

let isPreventingEnabled = false;
let kernel32: any = null;
let powerCreateRequest: any = null;
let powerSetRequest: any = null;
let powerClearRequest: any = null;
let closeHandle: any = null;
let powerRequestHandle: any = null;

// Define REASON_CONTEXT structure for koffi
let REASON_CONTEXT: any = null;

/**
 * Initialize the Windows API binding
 */
function initializeApi(): boolean {
  if (kernel32) return true;

  try {
    kernel32 = koffi.load('kernel32.dll');

    // Define the REASON_CONTEXT structure (simplified version for simple string)
    REASON_CONTEXT = koffi.struct('REASON_CONTEXT', {
      Version: 'uint32',
      Flags: 'uint32',
      SimpleReasonString: 'str16',  // LPWSTR (UTF-16 string pointer)
    });

    // PowerCreateRequest(PREASON_CONTEXT Context) -> HANDLE
    powerCreateRequest = kernel32.func('PowerCreateRequest', 'void*', [koffi.pointer(REASON_CONTEXT)]);

    // PowerSetRequest(HANDLE PowerRequest, POWER_REQUEST_TYPE RequestType) -> BOOL
    powerSetRequest = kernel32.func('PowerSetRequest', 'int', ['void*', 'int']);

    // PowerClearRequest(HANDLE PowerRequest, POWER_REQUEST_TYPE RequestType) -> BOOL
    powerClearRequest = kernel32.func('PowerClearRequest', 'int', ['void*', 'int']);

    // CloseHandle(HANDLE hObject) -> BOOL
    closeHandle = kernel32.func('CloseHandle', 'int', ['void*']);

    console.log('✅ Power API initialized successfully');
    return true;
  } catch (err) {
    console.error('Failed to load kernel32.dll:', err);
    return false;
  }
}

/**
 * Enable sleep prevention using PowerSetRequest.
 * This prevents Modern Standby (S0 Low Power Idle) from sleeping.
 * Screen can still turn off based on power settings.
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
    // Create REASON_CONTEXT with simple string
    const context = {
      Version: POWER_REQUEST_CONTEXT_VERSION,
      Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
      SimpleReasonString: 'DevRelay Agent: Maintaining server connection',
    };

    // Create power request
    powerRequestHandle = powerCreateRequest(context);

    if (!powerRequestHandle) {
      console.error('PowerCreateRequest failed');
      return false;
    }

    // Set the power request (prevent system sleep)
    const result = powerSetRequest(powerRequestHandle, PowerRequestSystemRequired);

    if (result !== 0) {
      isPreventingEnabled = true;
      console.log('✅ Sleep prevention enabled (PowerSetRequest - Modern Standby compatible)');
      return true;
    } else {
      console.error('PowerSetRequest failed');
      closeHandle(powerRequestHandle);
      powerRequestHandle = null;
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

  try {
    if (powerRequestHandle) {
      // Clear the power request
      powerClearRequest(powerRequestHandle, PowerRequestSystemRequired);

      // Close the handle
      closeHandle(powerRequestHandle);
      powerRequestHandle = null;
    }

    isPreventingEnabled = false;
    console.log('💤 Sleep prevention disabled (normal power management restored)');
    return true;
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
