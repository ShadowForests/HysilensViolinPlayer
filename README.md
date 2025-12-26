# Hysilens Violin Player - Web Edition

A web-based violin player that uses the Web Bluetooth API to connect to Arduino IMU devices and control music playback based on bow motion.

## 🎻 Features

- **Web Bluetooth Connection**: Connect to Arduino Nano 33 IoT or similar BLE devices
- **Real-time IMU Data**: Display accelerometer and gyroscope data from the device
- **Motion-Based Playback**: Control MP3 volume and playback based on bow motion speed
- **MIDI Support**: Play MIDI notes sequentially based on motion threshold
- **Auto-Reconnect**: Automatically reconnects to the last used device on page load
- **Smooth Volume Gradients**: Natural fade-in/fade-out based on motion speed
- **Motion Threshold Control**: Adjustable threshold for when audio plays
- **Bow Direction Detection**: Visual indication of bow direction (up-bow/down-bow)
- **Test Playback**: Preview audio without motion control

## 🚀 Getting Started

### Requirements

- **Browser**: Google Chrome or Microsoft Edge (version 79+)
- **Device**: Arduino Nano 33 IoT or compatible BLE device broadcasting IMU data
- **Protocol**: Device should broadcast comma-separated IMU data: `ax,ay,az,gx,gy,gz`

### Installation

1. Clone or download this repository
2. Place your MP3 files in the `web/tracks/` directory (optional)
3. Serve the files using a local web server:

```bash
# Using Python 3
python -m http.server 8000

# Using Node.js (http-server)
npx http-server

# Using PHP
php -S localhost:8000
```

4. Open your browser and navigate to `http://localhost:8000`

### Note on File Access

⚠️ **Important**: Modern browsers require HTTPS for Web Bluetooth API access (except on localhost). If deploying to production, ensure you're using HTTPS.

## 📱 Usage

### Connecting to Arduino

1. Click **"Connect Arduino"** button
2. Select your BLE device from the browser popup
3. Browse the discovered services and characteristics
4. Click on a characteristic with **NOTIFY** property to subscribe
5. The connection info is saved and will auto-reconnect on next visit

### Playback Modes

#### MP3 Mode
- Select an MP3 file using **"Select MP3 File"** or choose from **"Built-in Tracks"**
- When moving the bow above the motion threshold, the MP3 plays
- Volume adjusts based on motion speed with smooth gradients
- Pauses automatically when motion drops below threshold

#### MIDI Mode
- Click **"Playback Mode"** to switch to MIDI
- Select a MIDI file (or use the default scale)
- Notes play sequentially when motion is above threshold
- Each note plays with volume based on motion speed

### Controls

- **Max Volume**: Set the maximum volume level (0-100%)
- **Motion Threshold**: Set the motion speed needed to play audio (0-100%)
  - Lower values = more sensitive (plays with less motion)
  - Higher values = less sensitive (requires more motion)
- **IMU Playback**: Toggle motion-controlled playback on/off
- **Test Playback**: Preview audio without motion control
- **Seek Slider**: Jump to different positions in the audio

## 🔧 Technical Details

### IMU Data Format

The Arduino device should send data in this format:
```
ax,ay,az,gx,gy,gz\n
```

Example:
```
0.12,0.05,0.98,15.3,8.2,12.1
```

### Motion Calculation

```javascript
// Combined motion from gyroscope and accelerometer
gyroMagnitude = sqrt(gx² + gy² + gz²)
accelMagnitude = sqrt(ax² + ay² + az²)
combinedMotion = (gyroMagnitude × 0.7) + (accelMagnitude × 0.3)

// Smoothed with moving average (5 samples)
motionSpeed = average(last 5 combined motion values)
```

### Volume Gradient (MP3 Mode)

```javascript
normalizedSpeed = motionSpeed / MAX_MOTION_SPEED (250)

if (normalizedSpeed >= threshold) {
    volume = maxVolume  // Full volume
} else {
    // Smooth gradient with ease-in-out curve
    gradientProgress = normalizedSpeed / threshold
    smoothProgress = easeInOut(gradientProgress)
    volume = smoothProgress × maxVolume
    
    // Pause if volume < 5% of max
    if (volume < maxVolume × 0.05) {
        pause()
    }
}
```

### Bow Direction Detection

```javascript
if (ax > 0.2) → Up-Bow (moving right)
if (ax < -0.2) → Down-Bow (moving left)
```

## 🎨 Customization

### Adding Custom Tracks

1. Place MP3 files in `web/tracks/` directory
2. Edit the `showBuiltInTracks()` method in `app.js`:

```javascript
const tracks = [
    { name: "Your Track Name", url: "tracks/your_file.mp3" },
    // Add more tracks...
];
```

### Adjusting Motion Sensitivity

Modify these constants in `app.js`:

```javascript
this.MAX_MOTION_SPEED = 250.0;  // Maximum motion speed reference
this.motionThreshold = 0.15;    // Default threshold (15%)
this.maxHistorySize = 5;        // Motion smoothing window
```

### Styling

All styles are in `styles.css`. Key CSS variables:

```css
:root {
    --primary-color: #6366f1;
    --secondary-color: #8b5cf6;
    --background: #0f172a;
    --surface: #1e293b;
    /* ... */
}
```

## 🐛 Troubleshooting

### Web Bluetooth Not Working

- Ensure you're using Chrome or Edge (version 79+)
- Check that Bluetooth is enabled on your computer
- For HTTPS requirement: Use localhost for testing or deploy with HTTPS

### Device Not Found

- Ensure the Arduino is powered on and advertising
- Check that the device name matches or use "Accept All Devices"
- Try moving closer to the device

### No Audio Playback

- Check browser permissions for audio playback
- Ensure IMU Playback toggle is enabled
- Verify the audio file is loading correctly
- Check that motion speed exceeds the threshold

### Connection Drops

- Ensure stable Bluetooth connection (keep device close)
- Check Arduino battery level
- Verify the characteristic supports NOTIFY

## 📋 Browser Support

| Browser | Version | Support |
|---------|---------|---------|
| Chrome | 79+ | ✅ Full |
| Edge | 79+ | ✅ Full |
| Opera | 66+ | ✅ Full |
| Firefox | - | ❌ No Web Bluetooth |
| Safari | - | ❌ No Web Bluetooth |

## 🔐 Privacy & Security

- Connection information is stored locally (localStorage)
- No data is sent to external servers
- Audio files are processed locally in the browser
- Bluetooth connection is direct to your device

## 📜 License

This project is provided as-is for educational and personal use.

## 📞 Support

For issues or questions:
1. Check the troubleshooting section
2. Verify Web Bluetooth API support
3. Test with the browser console open for debugging

## 🔮 Future Enhancements

- [ ] MIDI file parsing library integration
- [ ] Multiple audio format support
- [ ] Recording and playback of practice sessions
- [ ] Visualization of motion data (graphs)
- [ ] Custom gesture recognition
- [ ] Multi-device support

---

**Note**: This web application requires a modern browser with Web Bluetooth API support. Best experienced on Chrome or Edge browsers on desktop or Android devices.

