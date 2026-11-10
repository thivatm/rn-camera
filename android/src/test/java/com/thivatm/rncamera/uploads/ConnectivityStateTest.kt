package com.thivatm.rncamera.uploads

import org.junit.Assert.assertEquals
import org.junit.Test

class ConnectivityStateTest {
  @Test
  fun noNetworkIsOffline() {
    assertEquals(ConnectivityState(false, "none"), ConnectivityState.of(null))
  }

  @Test
  fun networkWithoutInternetIsOffline() {
    assertEquals(
      ConnectivityState(false, "none"),
      ConnectivityState.of(NetworkInfo(hasInternet = false, wifi = true, cellular = false)),
    )
  }

  @Test
  fun wifiAndCellularAreReportedAsSuch() {
    assertEquals(
      ConnectivityState(true, "wifi"),
      ConnectivityState.of(NetworkInfo(hasInternet = true, wifi = true, cellular = false)),
    )
    assertEquals(
      ConnectivityState(true, "cellular"),
      ConnectivityState.of(NetworkInfo(hasInternet = true, wifi = false, cellular = true)),
    )
  }

  @Test
  fun otherTransportsAreOther() {
    assertEquals(
      ConnectivityState(true, "other"),
      ConnectivityState.of(NetworkInfo(hasInternet = true, wifi = false, cellular = false)),
    )
  }
}
