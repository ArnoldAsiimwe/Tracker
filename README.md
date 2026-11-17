# Device locator

A single-page GIS web app that locates a device by IP address, GPS coordinates, or interactive map pinning, and visualizes them on high-resolution satellite and street maps.

Built with vanilla HTML5, CSS3, and modern JavaScript. All tools and APIs are free with zero API keys required:
- **Leaflet.js**: Map visualization and spatial overlays
- **Esri World Imagery & OpenStreetMap**: Satellite imagery and street vector tiles
- **Browser Geolocation API (W3C)**: Device sensor & GPS positioning with hardware warm-up
- **ipwho.is & freeipapi.com**: Dual-provider IP geolocation with fallback
- **OpenStreetMap Nominatim**: Reverse geocoding for human-readable addresses

---

## Key Features

1. **Precision GPS with Multi-Sample Calibration**:
   - Rather than returning the very first rough network estimate, the GPS sensor runs an active warm-up loop over several seconds, sampling satellite fixes until it locks onto high accuracy (down to ±5–10 meters on mobile devices).
   - "Follow live" mode traces your real-time path and movement speed.
2. **IP vs. GPS Comparison**:
   - Automatically computes Haversine geodesic distance between your internet provider's hub and your true physical location, demonstrating network routing vs. sensor truth.
3. **Flexible Coordinate Support**:
   - Accepts decimal coordinates (`-0.6072, 30.6545`), cardinal degrees (`0.6072 S, 30.6545 E`), and DMS format (`0°36'26"S 30°39'16"E`).
4. **Instant Sharing & Navigation**:
   - Generates direct URL parameters (`?lat=...&lng=...`) to inspect locations.
   - **Google Maps & WhatsApp buttons**: Allows friends to immediately open the exact pin in Google Maps even before the project is hosted publicly.
5. **Reverse Geocoding**:
   - Automatically looks up nearest towns, streets, and districts for pinned or GPS-located coordinates.

---

## Run Locally

Open `index.html` directly in Chrome, Edge, or Firefox.

To test GPS on your local machine, run a local web server:

```bash
python -m http.server 8000
```
Then visit `http://localhost:8000`

### Testing on Your Phone with Real GPS
Mobile browsers require a secure connection (`https://`) to activate device GPS sensors:
1. Push your repository to **GitHub** and enable **GitHub Pages** (Settings -> Pages -> Branch: `main`).
2. Open the resulting `https://<your-username>.github.io/<repo>/` link on your phone.
3. Tap **"Use my GPS"** and select **Allow** when prompted.
