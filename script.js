// ---------- Map setup (all free, no API keys) ----------
const map = L.map('map', { zoomControl: false }).setView([-0.6072, 30.6545], 7);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);

const imagery = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' });
const placeNames = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19 });
const satellite = L.layerGroup([imagery, placeNames]).addTo(map);
const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{y}/{x}.png',
  { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' });
L.control.layers({ 'Satellite': satellite, 'Streets': streets }, null, { position: 'topright' }).addTo(map);

// Invalidate size once DOM is loaded to ensure 100% full container fill
setTimeout(() => map.invalidateSize(), 200);

// ---------- State ----------
const $ = id => document.getElementById(id);
const COLORS = { ip: '#2f7de1', gps: '#ff7a1a', manual: '#2e9e5b', friend: '#e02424' };
const LABELS = { ip: 'IP location', gps: 'Device GPS', manual: 'Entered/Pinned position', friend: 'Friend\'s Live Device' };
const SHORT = { ip: 'IP', gps: 'GPS', manual: 'Pinned', friend: 'Friend' };
const points = {};          // kind -> { marker, circle, lat, lng }
let watchId = null, trail = null, friendTrail = null, gpsWarmupTimeout = null;
const queryEl = $('query');

// Realtime Relay (HTTPS/SSE) State
let eventSource = null;
let currentTrackingChannel = null;
let isBroadcasting = false;

const IP_NOTE = 'An IP address shows where your internet provider\'s network exchange is registered, not where the phone or person is. For true physical precision, use device GPS.';
const GPS_NOTE = 'Precise position obtained from device GPS / hardware sensors with real-time accuracy margin.';
const MANUAL_NOTE = 'Position you entered or pinned. Drag the pin to adjust it.';
const FRIEND_NOTE = 'Live telemetric stream received directly from friend\'s device via Cloud Relay.';

function setStatus(msg, type = '') {
  const el = $('status');
  el.textContent = msg || '';
  el.className = type;
}

function pinIcon(color) {
  return L.divIcon({
    className: '',
    html: '<div class="pin" style="background:' + color + '"></div>',
    iconSize: [22, 22], iconAnchor: [11, 27]
  });
}

// ---------- Distance (haversine) ----------
function distanceKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function formatDistance(km) {
  return km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(km < 10 ? 1 : 0) + ' km';
}

// ---------- Reverse geocoding (OpenStreetMap Nominatim, free) ----------
async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`, {
      headers: { 'Accept-Language': 'en' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.display_name || null;
  } catch (e) {
    return null;
  }
}

// ---------- Draw or update a point ----------
function plot(kind, lat, lng, radius, opts = {}) {
  const p = points[kind];
  if (p) {
    p.marker.setLatLng([lat, lng]);
    p.circle.setLatLng([lat, lng]).setRadius(radius);
    p.lat = lat; p.lng = lng;
  } else {
    const color = COLORS[kind];
    const marker = L.marker([lat, lng], {
      icon: pinIcon(color), draggable: kind === 'manual', title: LABELS[kind]
    }).addTo(map);
    const circle = L.circle([lat, lng], {
      radius, color, weight: 2, fillColor: color, fillOpacity: 0.15,
      dashArray: kind === 'ip' ? '6, 6' : null
    }).addTo(map);
    marker.bindTooltip(LABELS[kind]);
    if (kind === 'manual') {
      marker.on('dragend', async () => {
        const ll = marker.getLatLng();
        plot('manual', ll.lat, ll.lng, 15, { noFit: true });
        queryEl.value = ll.lat.toFixed(5) + ', ' + ll.lng.toFixed(5);
        showDetails('manual', [['Source', 'Pinned on the map']], MANUAL_NOTE);
        const address = await reverseGeocode(ll.lat, ll.lng);
        if (address) {
          showDetails('manual', [['Source', 'Pinned on the map'], ['Approx. Area', address]], MANUAL_NOTE);
        }
      });
    }
    points[kind] = { marker, circle, lat, lng };
  }
  if (!opts.noFit) fitAll();
  refreshSummary();
}

function fitAll() {
  const circles = Object.values(points).map(p => p.circle);
  if (!circles.length) return;
  map.fitBounds(L.featureGroup(circles).getBounds(), { maxZoom: 17, padding: [40, 40] });
}

// ---------- Details and comparison panels ----------
function showDetails(kind, rows, note) {
  const p = points[kind];
  if (!p) return;
  $('resultTitle').textContent = LABELS[kind];
  const dl = $('details'); dl.innerHTML = '';
  rows.concat([['Coordinates', p.lat.toFixed(5) + ', ' + p.lng.toFixed(5)]]).forEach(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v || 'Unknown';
    dl.append(dt, dd);
  });
  $('note').textContent = note;
  $('result').style.display = 'block';
}

function refreshSummary() {
  const kinds = Object.keys(points);
  $('summary').style.display = kinds.length ? 'block' : 'none';
  if (!kinds.length) { $('result').style.display = 'none'; return; }

  const legend = $('legend'); legend.innerHTML = '';
  kinds.forEach(k => {
    const li = document.createElement('li');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = COLORS[k];
    const txt = document.createElement('span');
    txt.textContent = LABELS[k] + ': ' + points[k].lat.toFixed(4) + ', ' + points[k].lng.toFixed(4);
    li.append(dot, txt); legend.appendChild(li);
  });

  const dist = $('distances'); dist.innerHTML = '';
  const pairs = [['ip', 'gps'], ['ip', 'manual'], ['gps', 'manual'], ['gps', 'friend'], ['ip', 'friend']];
  pairs.forEach(([a, b]) => {
    if (points[a] && points[b]) {
      const li = document.createElement('li');
      li.textContent = SHORT[a] + ' and ' + SHORT[b] + ' are ' + formatDistance(distanceKm(points[a], points[b])) + ' apart';
      dist.appendChild(li);
    }
  });

  let msg = '';
  if (points.friend && points.gps) {
    msg = 'Tracking your friend live! Distance between you and your friend: ' + formatDistance(distanceKm(points.gps, points.friend)) + '.';
  } else if (points.ip && points.gps) {
    const d = distanceKm(points.ip, points.gps);
    msg = d > 20
      ? 'The IP address points to your ISP network center, whereas GPS gives your exact physical location.'
      : 'In this case the IP registration hub is fairly close to the device GPS.';
  }
  $('compareNote').textContent = msg;
}

// ---------- Input parsing with support for Degrees/Minutes & Cardinal directions ----------
const ipv4Re = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const ipv6Re = /^[0-9a-f:]+$/i;

function parseCoordinates(input) {
  let str = input.trim();
  const cardinalMatch = str.match(/^(-?\d+(?:\.\d+)?)\s*([NSns])?\s*[,/ ]\s*(-?\d+(?:\.\d+)?)\s*([EWew])?$/);
  if (cardinalMatch) {
    let lat = parseFloat(cardinalMatch[1]);
    let lng = parseFloat(cardinalMatch[3]);
    if (cardinalMatch[2] && cardinalMatch[2].toUpperCase() === 'S' && lat > 0) lat = -lat;
    if (cardinalMatch[4] && cardinalMatch[4].toUpperCase() === 'W' && lng > 0) lng = -lng;
    return { lat, lng };
  }
  const dmsMatch = str.match(/(\d+)°(?:(\d+)'(?:(\d+(?:\.\d+)?)"?)?)?\s*([NSns])\s*[,/ ]\s*(\d+)°(?:(\d+)'(?:(\d+(?:\.\d+)?)"?)?)?\s*([EWew])/i);
  if (dmsMatch) {
    let lat = parseFloat(dmsMatch[1]) + (parseFloat(dmsMatch[2] || 0) / 60) + (parseFloat(dmsMatch[3] || 0) / 3600);
    if (dmsMatch[4].toUpperCase() === 'S') lat = -lat;
    let lng = parseFloat(dmsMatch[5]) + (parseFloat(dmsMatch[6] || 0) / 60) + (parseFloat(dmsMatch[7] || 0) / 3600);
    if (dmsMatch[8].toUpperCase() === 'W') lng = -lng;
    return { lat, lng };
  }
  return null;
}

function isPrivateIp(ip) {
  const m = ip.match(ipv4Re);
  if (!m) return /^(fe80|fc|fd|::1)/i.test(ip);
  const a = +m[1], b = +m[2];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) ||
         (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0;
}

// ---------- Entered or pinned coordinates ----------
async function setManual(lat, lng, source) {
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    setStatus('Coordinates out of range. Latitude (-90 to 90) and Longitude (-180 to 180).', 'error');
    return;
  }
  plot('manual', lat, lng, 15, { noFit: source === 'Pinned on the map' });
  showDetails('manual', [['Source', source]], MANUAL_NOTE);
  setStatus(source === 'Pinned on the map' ? 'Pin dropped. Drag marker to adjust.' : 'Showing entered coordinates.', 'success');
  
  const address = await reverseGeocode(lat, lng);
  if (address) {
    showDetails('manual', [['Source', source], ['Approx. Area', address]], MANUAL_NOTE);
  }
}

// ---------- IP lookup with fallback (ipwho.is -> freeipapi.com) ----------
async function locateByIp(ip) {
  if (ip && isPrivateIp(ip)) {
    setStatus('Private / CGNAT IP address detected. These are local to your provider and cannot be geolocated publicly.', 'error');
    return;
  }
  const goBtn = $('go');
  goBtn.disabled = true;
  setStatus('Looking up IP location…', 'loading');

  try {
    let lat, lng, city, region, country, isp;
    try {
      const res = await fetch('https://ipwho.is/' + encodeURIComponent(ip || ''));
      const d = await res.json();
      if (!d.success) throw new Error(d.message || 'Lookup failed');
      lat = d.latitude; lng = d.longitude;
      city = d.city; region = d.region; country = d.country;
      isp = d.connection && (d.connection.isp || d.connection.org);
    } catch (err) {
      const resFallback = await fetch('https://freeipapi.com/api/json/' + encodeURIComponent(ip || ''));
      const fb = await resFallback.json();
      if (!fb.latitude) throw new Error('All IP services failed');
      lat = fb.latitude; lng = fb.longitude;
      city = fb.cityName; region = fb.regionName; country = fb.countryName;
      isp = 'Internet Provider';
    }

    plot('ip', lat, lng, 20000);
    showDetails('ip', [
      ['IP address', ip || 'Your public IP'],
      ['City', city], ['Region', region], ['Country', country],
      ['Network ISP', isp]
    ], IP_NOTE);
    setStatus('IP lookup complete. Use "Use my GPS" to compare with actual physical device location.', 'success');
  } catch (e) {
    setStatus('Could not look up that IP (' + e.message + '). Check your connection.', 'error');
  } finally {
    goBtn.disabled = false;
  }
}

// ---------- Device GPS with sensor warm-up for maximum accuracy ----------
function gpsRows(pos, placeName) {
  const c = pos.coords;
  const rows = [
    ['Accuracy', '± ' + Math.round(c.accuracy) + ' meters'],
    ['Speed', c.speed != null ? (c.speed * 3.6).toFixed(1) + ' km/h' : 'Stationary / N/A'],
    ['Timestamp', new Date(pos.timestamp).toLocaleTimeString()]
  ];
  if (placeName) rows.splice(1, 0, ['Approx. Location', placeName]);
  return rows;
}

function stopFollowing() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (gpsWarmupTimeout) {
    clearTimeout(gpsWarmupTimeout);
    gpsWarmupTimeout = null;
  }
  const gpsBtn = $('gps');
  if (gpsBtn) {
    gpsBtn.disabled = false;
    gpsBtn.classList.remove('btn-active');
    gpsBtn.textContent = 'Use my GPS';
  }
}

// Function to broadcast location to the tracking channel
async function broadcastLocation(lat, lng, accuracy, speed) {
  if (!currentTrackingChannel) return;
  try {
    await fetch(`https://ntfy.sh/${currentTrackingChannel}`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'location',
        lat,
        lng,
        accuracy,
        speed,
        timestamp: Date.now()
      })
    });
  } catch (err) {
    console.error('Relay broadcast error:', err);
  }
}

function locateByGps() {
  if (!('geolocation' in navigator)) {
    setStatus('Geolocation is not supported by this browser.', 'error');
    return;
  }

  const gpsBtn = $('gps');
  const isFollowing = $('follow').checked;

  if (watchId !== null && !isBroadcasting) {
    stopFollowing();
    setStatus('GPS tracking stopped.');
    return;
  }

  if (trail) { map.removeLayer(trail); trail = null; }

  if (gpsBtn) {
    gpsBtn.classList.add('btn-active');
    gpsBtn.textContent = isFollowing ? 'Stop live tracking' : 'Locking GPS…';
  }
  setStatus('Contacting GPS & satellite sensors… allow permission if prompted.', 'loading');

  const opts = { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 };

  const onError = err => {
    stopFollowing();
    if (err.code === 1) {
      setStatus('Location permission denied. Please allow location in your browser / phone settings.', 'error');
    } else if (err.code === 2) {
      setStatus('GPS signal unavailable. Ensure location/GPS services are turned on on your device.', 'error');
    } else {
      setStatus('GPS request timed out. If indoors, move near a window for better satellite visibility.', 'error');
    }
  };

  let bestAccuracy = Infinity;
  let sampleCount = 0;

  if (isFollowing) {
    let first = true;
    watchId = navigator.geolocation.watchPosition(async pos => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      plot('gps', lat, lng, Math.max(accuracy, 8), { noFit: !first });
      showDetails('gps', gpsRows(pos), GPS_NOTE);
      
      if (!trail) trail = L.polyline([], { color: COLORS.gps, weight: 4 }).addTo(map);
      trail.addLatLng([lat, lng]);

      // Broadcast to cloud relay if actively tracking
      if (currentTrackingChannel) {
        broadcastLocation(lat, lng, accuracy, pos.coords.speed);
      }

      if (first) {
        map.setView([lat, lng], 17);
        first = false;
      }
      setStatus(`Following live (accuracy: ±${Math.round(accuracy)}m). Tap "Stop live tracking" to end.`, 'success');
    }, onError, opts);

  } else {
    setStatus('Refining GPS satellite fix for highest precision…', 'loading');
    let lastBestPos = null;

    watchId = navigator.geolocation.watchPosition(async pos => {
      sampleCount++;
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;

      if (accuracy < bestAccuracy) {
        bestAccuracy = accuracy;
        lastBestPos = pos;
        plot('gps', lat, lng, Math.max(accuracy, 8));
        showDetails('gps', gpsRows(pos), GPS_NOTE);
      }

      // Broadcast update
      if (currentTrackingChannel) {
        broadcastLocation(lat, lng, accuracy, pos.coords.speed);
      }

      setStatus(`Locking satellites (sample ${sampleCount}: ±${Math.round(accuracy)}m accuracy)…`, 'loading');

      if (accuracy <= 15 || sampleCount >= 4) {
        finishGpsCalibration(lastBestPos);
      }
    }, onError, opts);

    gpsWarmupTimeout = setTimeout(() => {
      if (lastBestPos) finishGpsCalibration(lastBestPos);
    }, 7000);
  }
}

async function finishGpsCalibration(pos) {
  if (!isBroadcasting) stopFollowing();
  if (!pos) return;
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  plot('gps', lat, lng, Math.max(accuracy, 8));
  map.setView([lat, lng], 17);

  let hint = accuracy > 1000
    ? `Estimated position (±${Math.round(accuracy)}m). On a laptop without GPS, Wi-Fi triangulation is used. Open on a phone for pinpoint GPS.`
    : `High-accuracy GPS lock acquired (±${Math.round(accuracy)} meters).`;

  setStatus(hint, 'success');
  const address = await reverseGeocode(lat, lng);
  showDetails('gps', gpsRows(pos, address), GPS_NOTE);
}

// ---------- High-Reliability Cloud HTTPS/SSE Relay (Option 2) ----------
function initRealtimeHost() {
  // Generate a distinct channel topic
  const channel = 'tracker_' + Math.random().toString(36).substring(2, 10);
  currentTrackingChannel = channel;

  const base = location.href.split('?')[0].split('#')[0];
  const link = `${base}?join=${channel}`;
  $('sessionLinkInput').value = link;
  $('sessionShareArea').style.display = 'block';
  $('startSession').style.display = 'none';
  $('peerStatus').textContent = 'Waiting for your friend to open the link on their phone…';

  // Close previous stream if open
  if (eventSource) eventSource.close();

  // Connect to SSE stream
  eventSource = new EventSource(`https://ntfy.sh/${channel}/sse`);

  eventSource.onopen = () => {
    $('peerStatus').textContent = '📡 Tracking channel live. Send the link to your friend!';
  };

  eventSource.onmessage = async event => {
    try {
      const envelope = JSON.parse(event.data);
      if (envelope.event !== 'message' || !envelope.message) return;
      
      const data = JSON.parse(envelope.message);
      if (data.type === 'location') {
        const { lat, lng, accuracy } = data;

        // Auto reload/update map with Friend's pin!
        plot('friend', lat, lng, Math.max(accuracy || 10, 8));

        if (!friendTrail) friendTrail = L.polyline([], { color: COLORS.friend, weight: 4 }).addTo(map);
        friendTrail.addLatLng([lat, lng]);

        $('peerStatus').textContent = `✅ Live friend position received! (Accuracy: ±${Math.round(accuracy || 10)}m)`;
        $('peerStatus').style.background = '#eef7f4';
        $('peerStatus').style.color = '#0d5a4d';

        const rows = [
          ['Device', 'Friend\'s Live Phone'],
          ['Accuracy', '± ' + Math.round(accuracy || 10) + ' m'],
          ['Speed', data.speed != null ? (data.speed * 3.6).toFixed(1) + ' km/h' : 'Stationary / N/A'],
          ['Last Update', new Date(data.timestamp || Date.now()).toLocaleTimeString()]
        ];
        showDetails('friend', rows, FRIEND_NOTE);

        // Center map to friend's position
        map.setView([lat, lng], 16);
      }
    } catch (e) {
      console.log('Ignored non-json ping:', e);
    }
  };

  eventSource.onerror = () => {
    $('peerStatus').textContent = 'Reconnecting to cloud relay…';
  };
}

function initRealtimeClient(channelId) {
  currentTrackingChannel = channelId;
  isBroadcasting = true;

  const card = $('realtimeCard');
  card.innerHTML = `
    <h2>📱 Share Your Live Location</h2>
    <p class="hint">A friend has requested to track this device. Tap the button below to stream your satellite GPS position directly to their map:</p>
    <button id="sendGpsBtn" type="button" style="background:#e02424;border-color:#b91c1c;padding:12px;">Start Sharing My GPS</button>
    <div id="clientStatus" class="pulse-status" style="margin-top:8px;">Ready to stream location.</div>
  `;

  // Pre-load map immediately
  setTimeout(() => map.invalidateSize(), 300);

  const sendBtn = $('sendGpsBtn');
  sendBtn.addEventListener('click', () => {
    sendBtn.textContent = 'Broadcasting GPS live…';
    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.85';
    $('follow').checked = true;

    $('clientStatus').textContent = 'Acquiring GPS fix and broadcasting to your friend…';
    $('clientStatus').style.background = '#eef7f4';
    $('clientStatus').style.color = '#0d5a4d';

    locateByGps();
  });
}

// Session buttons
$('startSession').addEventListener('click', initRealtimeHost);

$('copySessionBtn').addEventListener('click', async () => {
  const link = $('sessionLinkInput').value;
  try {
    await navigator.clipboard.writeText(link);
    setStatus('Tracking link copied! Send it to your friend.', 'success');
  } catch (e) {
    window.prompt('Copy this link and send to your friend:', link);
  }
});

$('waSessionBtn').addEventListener('click', () => {
  const link = $('sessionLinkInput').value;
  const msg = encodeURIComponent(`Open this link on your phone and tap "Start Sharing My GPS" so I can track your location: ${link}`);
  window.open('https://wa.me/?text=' + msg, '_blank');
});

// ---------- Share & External Map Handlers ----------
function bestPoint() { return points.friend || points.gps || points.manual || points.ip; }

function shareUrl() {
  const p = bestPoint();
  const base = location.href.split('?')[0].split('#')[0];
  return base + '?lat=' + p.lat.toFixed(6) + '&lng=' + p.lng.toFixed(6);
}

$('copy').addEventListener('click', async () => {
  const p = bestPoint();
  if (!p) { setStatus('No location to share yet. Locate someone or drop a pin first.', 'error'); return; }
  const url = shareUrl();
  try {
    await navigator.clipboard.writeText(url);
    setStatus('Pin link copied to clipboard!', 'success');
  } catch (e) {
    window.prompt('Copy this link:', url);
  }
});

$('gmaps').addEventListener('click', () => {
  const p = bestPoint();
  if (!p) { setStatus('No location to view. Locate first.', 'error'); return; }
  window.open(`https://www.google.com/maps?q=${p.lat.toFixed(6)},${p.lng.toFixed(6)}`, '_blank');
});

$('wa').addEventListener('click', () => {
  const p = bestPoint();
  if (!p) { setStatus('No location to share. Locate first.', 'error'); return; }
  const gmapLink = `https://maps.google.com/?q=${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const text = encodeURIComponent(`Device Location: ${gmapLink}\nApp Viewer: ${shareUrl()}`);
  window.open('https://wa.me/?text=' + text, '_blank');
});

// ---------- Controls ----------
function clearAll() {
  stopFollowing();
  if (trail) { map.removeLayer(trail); trail = null; }
  if (friendTrail) { map.removeLayer(friendTrail); friendTrail = null; }
  Object.keys(points).forEach(k => {
    map.removeLayer(points[k].marker); map.removeLayer(points[k].circle); delete points[k];
  });
  refreshSummary();
  setStatus('Map cleared.');
}

function handleLocate() {
  stopFollowing();
  const q = queryEl.value.trim();
  if (!q) return locateByIp('');

  const coords = parseCoordinates(q);
  if (coords) return setManual(coords.lat, coords.lng, 'Entered coordinates');
  if (ipv4Re.test(q)) {
    if (!q.split('.').every(n => +n >= 0 && +n <= 255)) {
      return setStatus('Each octet of an IPv4 address must be between 0 and 255.', 'error');
    }
    return locateByIp(q);
  }
  if (q.includes(':') && ipv6Re.test(q)) return locateByIp(q);
  setStatus('Enter a valid IP address or coordinates.', 'error');
}

$('go').addEventListener('click', handleLocate);
$('gps').addEventListener('click', locateByGps);
$('clear').addEventListener('click', clearAll);
queryEl.addEventListener('keydown', e => { if (e.key === 'Enter') handleLocate(); });

$('follow').addEventListener('change', e => {
  if (!e.target.checked && watchId !== null && !isBroadcasting) {
    stopFollowing();
    setStatus('Live tracking paused.');
  }
});

map.on('click', async e => {
  queryEl.value = e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5);
  setManual(e.latlng.lat, e.latlng.lng, 'Pinned on the map');
});

// ---------- URL Routing on Page Load ----------
(function handleUrlParams() {
  const params = new URLSearchParams(location.search);
  
  // If user opened with a ?join=CHANNEL parameter, they are the friend streaming GPS
  const joinChannel = params.get('join');
  if (joinChannel) {
    initRealtimeClient(joinChannel);
    return;
  }

  // If opened with static lat/lng coordinates
  const lat = parseFloat(params.get('lat')), lng = parseFloat(params.get('lng'));
  if (!isNaN(lat) && !isNaN(lng)) {
    setManual(lat, lng, 'Shared link');
    map.setView([lat, lng], 16);
  }
})();
