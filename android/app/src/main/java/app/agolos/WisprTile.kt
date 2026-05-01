package app.agolos

import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * Quick Settings tile — primary user trigger for invoking dictation
 * without leaving the foreground app. User pulls down their notification
 * shade twice, taps the А-ГОЛОС tile, the overlay appears.
 *
 * Tile must be added to the QS panel manually first (Edit tiles in QS panel
 * → drag А-ГОЛОС up). MainActivity onboarding tells the user how.
 */
class WisprTile : TileService() {

    override fun onStartListening() {
        super.onStartListening()
        qsTile?.apply {
            label = "А-ГОЛОС"
            state = Tile.STATE_INACTIVE
            updateTile()
        }
    }

    override fun onClick() {
        super.onClick()
        // Briefly show "active" while we kick off the overlay; the tile
        // returns to STATE_INACTIVE on the next onStartListening cycle.
        qsTile?.apply { state = Tile.STATE_ACTIVE; updateTile() }
        WisprService.startDictation(this)
    }
}
