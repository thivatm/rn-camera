package com.thivatm.rncamera.uploads

import com.facebook.react.bridge.ReactApplicationContext
import com.thivatm.rncamera.NativeRecordingUploadsSpec

/**
 * Turbo Module `RecordingUploads`: native transport, file primitives and
 * signals behind the shared TS upload engine. Empty until the native transport
 * ticket fills it in.
 */
class RecordingUploadsModule(reactContext: ReactApplicationContext) :
  NativeRecordingUploadsSpec(reactContext) {

  companion object {
    const val NAME = NativeRecordingUploadsSpec.NAME
  }
}
