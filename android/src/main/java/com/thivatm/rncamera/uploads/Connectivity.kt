package com.thivatm.rncamera.uploads

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities

/** The facts about the default network that the upload engine cares about. */
data class NetworkInfo(val hasInternet: Boolean, val wifi: Boolean, val cellular: Boolean)

/**
 * Connectivity signal for the upload engine. [networkType] is one of
 * `wifi`, `cellular`, `other` (e.g. ethernet, VPN without an underlying
 * transport we recognise) or `none`.
 */
data class ConnectivityState(val isConnected: Boolean, val networkType: String) {
  companion object {
    fun of(network: NetworkInfo?): ConnectivityState =
      when {
        network == null || !network.hasInternet -> ConnectivityState(false, "none")
        network.wifi -> ConnectivityState(true, "wifi")
        network.cellular -> ConnectivityState(true, "cellular")
        else -> ConnectivityState(true, "other")
      }
  }
}

/**
 * Watches the default network through [ConnectivityManager] and reports
 * [ConnectivityState] changes (deduplicated) to [onChange].
 */
class ConnectivityMonitor(context: Context, private val onChange: (ConnectivityState) -> Unit) {
  private val manager = context.getSystemService(ConnectivityManager::class.java)
  private var last: ConnectivityState? = null
  private var started = false

  private val callback = object : ConnectivityManager.NetworkCallback() {
    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) =
      publish(ConnectivityState.of(info(capabilities)))

    override fun onLost(network: Network) = publish(current())
  }

  /** The default network's state right now. */
  fun current(): ConnectivityState {
    val network = manager.activeNetwork ?: return ConnectivityState.of(null)
    return ConnectivityState.of(manager.getNetworkCapabilities(network)?.let(::info))
  }

  @Synchronized
  fun start() {
    if (started) return
    started = true
    manager.registerDefaultNetworkCallback(callback)
  }

  @Synchronized
  fun stop() {
    if (!started) return
    started = false
    manager.unregisterNetworkCallback(callback)
  }

  @Synchronized
  private fun publish(state: ConnectivityState) {
    if (state == last) return
    last = state
    onChange(state)
  }

  private fun info(capabilities: NetworkCapabilities) = NetworkInfo(
    hasInternet = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
    wifi = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
    cellular = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
  )
}
