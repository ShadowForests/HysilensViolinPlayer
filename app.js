// Hysilens Violin Player - Web Edition
// Web Bluetooth API Implementation

class ViolinPlayer {
    constructor() {
        // Bluetooth
        this.device = null;
        this.server = null;
        this.characteristic = null;
        this.bleBuffer = '';
        this.isConnecting = false; // Prevent multiple connection attempts
        this.disconnectListenerAdded = false; // Track if listener is already added

        // Audio
        this.audioContext = null;
        this.audioElement = null;
        this.audioSource = null;
        this.currentTrack = null;
        this.isTestPlaying = false;
        this.isImuPlaying = true; // Default to true
        this.onMetadataLoaded = null; // Track metadata listener to prevent duplicates

        // IMU Data
        this.imuData = { ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 };
        this.motionSpeed = 0;
        this.motionHistory = [];
        this.maxHistorySize = 5;
        this.lastBowDirection = 0;
        this.bowDirection = 'Unknown';
        this.rawOutputLines = [];

        // Playback Mode
        this.playbackMode = 'MP3'; // 'MP3' or 'MIDI'
        this.midiNotes = [];
        this.currentNoteIndex = 0;
        this.midiPlaybackInterval = null;
        this.midiAudioContext = null;

        // Violin sample for MIDI playback
        this.violinSampleBuffer = null; // AudioBuffer for violin_a4.wav
        this.violinBaseNote = 69; // A4 = MIDI note 69
        this.currentMidiSource = null; // Current playing note source
        this.noteStopTimeout = null; // Timeout to stop note after duration

        // Settings
        this.maxVolume = 1.0;
        this.motionThreshold = 0.15; // 15%
        this.currentVolume = 0;

        // Constants
        this.MAX_MOTION_SPEED = 250.0;

        // Saved connection info
        this.savedConnection = this.loadSavedConnection();

        this.init();
    }

    init() {
        this.setupAudio();
        this.setupEventListeners();
        this.updateUI();

        // Load default tracks
        this.loadDefaultTracks();

        // Attempt auto-reconnect after short delay
        setTimeout(() => this.attemptAutoReconnect(), 1000);
    }

    setupAudio() {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        this.audioElement = new Audio();
        this.audioElement.loop = true;
        this.audioElement.volume = 0; // Start muted

        // Setup audio context for MIDI with violin sample
        this.midiAudioContext = new (window.AudioContext || window.webkitAudioContext)();

        // Load violin_a4.wav sample for MIDI playback
        this.loadViolinSample();
    }

    async loadViolinSample() {
        try {
            const response = await fetch('assets/sfx/violin_a4.wav');
            const arrayBuffer = await response.arrayBuffer();
            this.violinSampleBuffer = await this.midiAudioContext.decodeAudioData(arrayBuffer);
            console.log('Violin sample loaded successfully (A4 = MIDI 69)');
        } catch (error) {
            console.error('Error loading violin sample:', error);
            console.warn('MIDI playback will use fallback sine wave');
        }
    }

    setupEventListeners() {
        // Connection buttons
        document.getElementById('connectBtn').addEventListener('click', () => this.connectDevice());
        document.getElementById('disconnectBtn').addEventListener('click', () => this.disconnect());

        // Playback mode
        document.getElementById('playbackModeBtn').addEventListener('click', () => this.togglePlaybackMode());

        // Track selection
        document.getElementById('selectFileBtn').addEventListener('click', () => {
            document.getElementById('fileInput').click();
        });
        document.getElementById('fileInput').addEventListener('change', (e) => this.handleFileSelect(e));

        // Built-in tracks
        document.getElementById('builtInTracksBtn').addEventListener('click', () => this.showBuiltInTracks());
        document.getElementById('closeTracksModal').addEventListener('click', () => this.closeModal('tracksModal'));

        // MIDI file selection
        document.getElementById('selectMidiBtn').addEventListener('click', () => {
            document.getElementById('midiFileInput').click();
        });
        document.getElementById('midiFileInput').addEventListener('change', (e) => this.handleMidiFileSelect(e));
        document.getElementById('builtInMidiBtn').addEventListener('click', () => this.showBuiltInMidiFiles());
        document.getElementById('closeMidiModal').addEventListener('click', () => this.closeModal('midiModal'));

        // IMU playback toggle
        document.getElementById('imuPlaybackBtn').addEventListener('click', () => this.toggleImuPlayback());

        // Test playback
        document.getElementById('testPlaybackBtn').addEventListener('click', () => this.toggleTestPlayback());

        // Seek slider
        document.getElementById('seekSlider').addEventListener('input', (e) => this.seekTo(e.target.value));

        // Volume controls
        document.getElementById('maxVolumeSlider').addEventListener('input', (e) => {
            this.maxVolume = e.target.value / 100;
            document.getElementById('maxVolumeValue').textContent = e.target.value;
        });

        document.getElementById('motionThresholdSlider').addEventListener('input', (e) => {
            this.motionThreshold = e.target.value / 100;
            document.getElementById('motionThresholdValue').textContent = e.target.value;
        });

        // Service modal
        document.getElementById('closeServiceModal').addEventListener('click', () => this.closeModal('serviceModal'));

        // Update playback position
        setInterval(() => this.updatePlaybackPosition(), 100);
    }

    // ===== BLUETOOTH CONNECTION =====

    async connectDevice() {
        // Prevent multiple connection attempts
        if (this.isConnecting) {
            console.log('Connection already in progress');
            return;
        }

        try {
            this.isConnecting = true;
            this.updateStatus('Connecting...');

            // Request Bluetooth device
            // Web Bluetooth requires services to be declared in optionalServices
            // Add your custom service UUID here if it's not discovered
            const commonServices = [
                // Standard services
                'generic_access',
                'generic_attribute',
                'device_information',
                'battery_service',
                // Common custom services
                '12345678-1234-5678-1234-56789abcdef0',
                '12345678-1234-5678-1234-56789abcdef1',
                '19b10000-e8f2-537e-4f6c-d104768a1214', // Arduino Nano 33 IoT IMU service
                '19b10001-e8f2-537e-4f6c-d104768a1214', // Arduino characteristic
                '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART service
                '0000180d-0000-1000-8000-00805f9b34fb', // Heart Rate
                '0000180f-0000-1000-8000-00805f9b34fb', // Battery Service
                '0000181a-0000-1000-8000-00805f9b34fb', // Environmental Sensing
                '0000181c-0000-1000-8000-00805f9b34fb', // User Data
                // Add more as needed - check your Arduino code for the service UUID
            ];

            this.device = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: commonServices
            });

            console.log('Device selected:', this.device.name);

            // Add disconnect listener only once
            if (!this.disconnectListenerAdded) {
                this.device.addEventListener('gattserverdisconnected', this.handleDisconnect.bind(this));
                this.disconnectListenerAdded = true;
                console.log('Disconnect listener added');
            }

            this.updateStatus('Connecting to GATT server...');
            this.server = await this.device.gatt.connect();

            // Verify connection is established
            if (!this.server || !this.server.connected) {
                throw new Error('Failed to establish GATT connection');
            }

            console.log('GATT server connected successfully');
            this.updateStatus('Connected. Discovering services...');

            // Verify still connected after delay
            if (!this.server.connected) {
                throw new Error('Connection lost during initialization');
            }

            const services = await this.server.getPrimaryServices();
            console.log(`Discovered ${services.length} services`);

            // Show service selector
            this.showServiceSelector(services);

        } catch (error) {
            console.error('Connection error:', error);
            this.updateStatus('Connection failed: ' + error.message);
            this.isConnecting = false;
            this.disconnectListenerAdded = false;
        } finally {
            this.isConnecting = false;
        }
    }

    handleDisconnect() {
        console.log('Device disconnected - handleDisconnect called');
        this.disconnectListenerAdded = false;

        // Don't call disconnect() if we're already disconnecting
        if (!this.device || !this.server) {
            return;
        }

        this.updateStatus('Device disconnected');

        // Clean up without trying to disconnect again
        this.device = null;
        this.server = null;
        this.characteristic = null;

        document.getElementById('disconnectBtn').disabled = true;
        document.getElementById('imuSection').style.display = 'none';

        if (this.audioElement) {
            this.audioElement.pause();
        }
    }

    async showServiceSelector(services) {
        const servicesList = document.getElementById('servicesList');
        servicesList.innerHTML = '';

        console.log('=== DISCOVERED SERVICES ===');
        console.log(`Total services found: ${services.length}`);
        services.forEach((service, index) => {
            console.log(`Service ${index + 1}: ${service.uuid} (${this.getServiceName(service.uuid)})`);
        });
        console.log('===========================');

        if (services.length === 0) {
            servicesList.innerHTML = `
                <div style="padding: 20px; text-align: center; color: #ef4444;">
                    <h3>⚠️ No Services Found</h3>
                    <p>Your Arduino's custom service UUID may not be in the optionalServices list.</p>
                    <p><strong>To fix:</strong> Check your Arduino code for the service UUID and add it to the commonServices array in app.js (line ~134)</p>
                    <p>Example: '19b10000-e8f2-537e-4f6c-d104768a1214'</p>
                </div>
            `;
            return;
        }

        for (const service of services) {
            const serviceDiv = document.createElement('div');
            serviceDiv.className = 'service-item';

            const serviceHeader = document.createElement('div');
            serviceHeader.className = 'service-header';
            serviceHeader.innerHTML = `
                <div>
                    <div>${this.getServiceName(service.uuid)}</div>
                    <div class="service-uuid">${service.uuid}</div>
                </div>
                <span>▼</span>
            `;

            const characteristicsList = document.createElement('div');
            characteristicsList.className = 'characteristics-list';

            serviceHeader.addEventListener('click', () => {
                characteristicsList.classList.toggle('active');
            });

            try {
                const characteristics = await service.getCharacteristics();

                for (const characteristic of characteristics) {
                    const charDiv = document.createElement('div');
                    charDiv.className = 'characteristic-item';
                    charDiv.innerHTML = `
                        <div>${this.getCharacteristicName(characteristic.uuid)}</div>
                        <div class="service-uuid">${characteristic.uuid}</div>
                        <div class="characteristic-properties">${this.getPropertiesString(characteristic.properties)}</div>
                    `;

                    charDiv.addEventListener('click', () => {
                        this.selectCharacteristic(characteristic, service.uuid);
                    });

                    characteristicsList.appendChild(charDiv);
                }
            } catch (error) {
                console.error('Error getting characteristics:', error);
            }

            serviceDiv.appendChild(serviceHeader);
            serviceDiv.appendChild(characteristicsList);
            servicesList.appendChild(serviceDiv);
        }

        this.showModal('serviceModal');
    }

    async selectCharacteristic(characteristic, serviceUuid) {
        try {
            this.characteristic = characteristic;

            // Save connection info
            this.saveConnection(this.device.id, this.device.name, serviceUuid, characteristic.uuid);

            this.closeModal('serviceModal');
            this.updateStatus('Subscribing to characteristic...');

            // Start notifications
            await characteristic.startNotifications();
            characteristic.addEventListener('characteristicvaluechanged', (event) => {
                this.handleBleData(event.target.value);
            });

            this.updateStatus('Connected and subscribed!');
            document.getElementById('disconnectBtn').disabled = false;
            document.getElementById('imuSection').style.display = 'block';

            // Start audio if IMU playback is on
            if (this.isImuPlaying && this.audioElement.src) {
                this.audioElement.play().catch(e => console.log('Audio play error:', e));
            }

        } catch (error) {
            console.error('Subscription error:', error);
            this.updateStatus('Subscription failed: ' + error.message);
        }
    }

    async attemptAutoReconnect() {
        if (!this.savedConnection || this.device || this.isConnecting) {
            return;
        }

        try {
            this.isConnecting = true;
            this.updateStatus('Auto-reconnecting...');

            // Request the same device
            const devices = await navigator.bluetooth.getDevices();
            const savedDevice = devices.find(d => d.id === this.savedConnection.deviceId);

            if (!savedDevice) {
                console.log('Saved device not found');
                this.isConnecting = false;
                return;
            }

            this.device = savedDevice;

            // Add disconnect listener only once
            if (!this.disconnectListenerAdded) {
                this.device.addEventListener('gattserverdisconnected', this.handleDisconnect.bind(this));
                this.disconnectListenerAdded = true;
                console.log('Disconnect listener added during auto-reconnect');
            }

            console.log('Connecting to saved device...');
            this.server = await this.device.gatt.connect();

            // Verify connection is established
            if (!this.server || !this.server.connected) {
                throw new Error('Failed to establish GATT connection during auto-reconnect');
            }

            console.log('Auto-reconnect: GATT server connected');

            // Add longer delay to ensure connection is stable
            await new Promise(resolve => setTimeout(resolve, 300));

            // Verify still connected after delay
            if (!this.server.connected) {
                throw new Error('Connection lost during auto-reconnect initialization');
            }

            // Find the saved service and characteristic
            const services = await this.server.getPrimaryServices();
            console.log(`Auto-reconnect: Found ${services.length} services`);

            for (const service of services) {
                if (service.uuid === this.savedConnection.serviceUuid) {
                    const characteristics = await service.getCharacteristics();
                    for (const char of characteristics) {
                        if (char.uuid === this.savedConnection.characteristicUuid) {
                            await this.selectCharacteristic(char, service.uuid);
                            this.updateStatus('Auto-reconnected!');
                            this.isConnecting = false;
                            return;
                        }
                    }
                }
            }

            throw new Error('Saved characteristic not found');

        } catch (error) {
            console.log('Auto-reconnect failed:', error);
            this.updateStatus('Disconnected');
            this.disconnectListenerAdded = false;
            this.isConnecting = false;
        }
    }

    disconnect() {
        console.log('Disconnect called');

        try {
            if (this.device && this.device.gatt && this.device.gatt.connected) {
                console.log('Disconnecting GATT...');
                this.device.gatt.disconnect();
            }
        } catch (error) {
            console.error('Error during disconnect:', error);
        }

        // Reset all connection state
        this.device = null;
        this.server = null;
        this.characteristic = null;
        this.isConnecting = false;
        this.disconnectListenerAdded = false;

        this.updateStatus('Disconnected');
        document.getElementById('disconnectBtn').disabled = true;
        document.getElementById('imuSection').style.display = 'none';

        if (this.audioElement) {
            this.audioElement.pause();
        }
    }

    // ===== BLE DATA PROCESSING =====

    handleBleData(value) {
        const decoder = new TextDecoder();
        const chunk = decoder.decode(value);
        this.bleBuffer += chunk;

        // Process complete lines
        const lines = this.bleBuffer.split('\n');
        this.bleBuffer = lines.pop() || ''; // Keep incomplete line in buffer

        lines.forEach(line => {
            if (line.trim()) {
                this.processData(line.trim());
            }
        });
    }

    processData(line) {
        // Add to raw output
        this.rawOutputLines.push(line);
        if (this.rawOutputLines.length > 5) {
            this.rawOutputLines.shift();
        }
        this.updateRawOutput();

        // Parse IMU data (format: ax,ay,az,gx,gy,gz)
        const parts = line.split(',');
        if (parts.length >= 6) {
            this.imuData = {
                ax: parseFloat(parts[0]) || 0,
                ay: parseFloat(parts[1]) || 0,
                az: parseFloat(parts[2]) || 0,
                gx: parseFloat(parts[3]) || 0,
                gy: parseFloat(parts[4]) || 0,
                gz: parseFloat(parts[5]) || 0
            };

            this.detectBowDirection();
            this.updateAudioVolume();
            this.updateImuDisplay();
        }
    }

    detectBowDirection() {
        const accelThreshold = 0.2;
        const currentDirection = this.imuData.ax > accelThreshold ? 1 :
                                this.imuData.ax < -accelThreshold ? -1 :
                                this.lastBowDirection;

        if (currentDirection !== 0 && this.lastBowDirection !== 0 && currentDirection !== this.lastBowDirection) {
            this.bowDirection = currentDirection > 0 ? 'Up-Bow →' : 'Down-Bow ←';

            // Show change indicator
            const changeBadge = document.getElementById('directionChange');
            changeBadge.style.display = 'inline-block';
            setTimeout(() => changeBadge.style.display = 'none', 200);
        }

        if (currentDirection !== 0) {
            this.lastBowDirection = currentDirection;
            this.bowDirection = currentDirection > 0 ? 'Up-Bow →' : 'Down-Bow ←';
        }
    }

    updateAudioVolume() {
        // Calculate motion speed
        const gyroMagnitude = Math.sqrt(
            this.imuData.gx * this.imuData.gx +
            this.imuData.gy * this.imuData.gy +
            this.imuData.gz * this.imuData.gz
        );

        const accelMagnitude = Math.sqrt(
            this.imuData.ax * this.imuData.ax +
            this.imuData.ay * this.imuData.ay +
            this.imuData.az * this.imuData.az
        );

        const combinedMotion = (gyroMagnitude * 0.7) + (accelMagnitude * 0.3);

        // Smooth motion with history
        this.motionHistory.push(combinedMotion);
        if (this.motionHistory.length > this.maxHistorySize) {
            this.motionHistory.shift();
        }

        this.motionSpeed = this.motionHistory.reduce((a, b) => a + b, 0) / this.motionHistory.length;

        // Control MIDI playback
        if (this.playbackMode === 'MIDI' && this.isImuPlaying) {
            this.controlMidiPlayback();
        }

        // Control MP3 volume if not in test mode and IMU playback is active
        if (this.playbackMode === 'MP3' && !this.isTestPlaying && this.isImuPlaying && this.audioElement.src) {
            const normalizedSpeed = Math.min(this.motionSpeed / this.MAX_MOTION_SPEED, 1.0);
            const threshold = this.motionThreshold;

            if (normalizedSpeed >= threshold) {
                // Above threshold: Full volume
                if (this.audioElement.paused) {
                    this.audioElement.play().catch(e => console.log('Play error:', e));
                }
                this.currentVolume = this.maxVolume;
                this.audioElement.volume = this.currentVolume;

            } else {
                // Below threshold: Gradient fade or pause
                const gradientProgress = Math.min(normalizedSpeed / threshold, 1.0);

                // Ease-in-out curve
                const smoothProgress = gradientProgress < 0.5 ?
                    2 * gradientProgress * gradientProgress :
                    1 - 2 * Math.pow(1 - gradientProgress, 2);

                const targetVolume = smoothProgress * this.maxVolume;

                // Pause if volume too low
                const shouldPause = targetVolume < (this.maxVolume * 0.05);

                if (shouldPause) {
                    if (!this.audioElement.paused) {
                        this.audioElement.pause();
                    }
                    this.currentVolume = 0;
                } else {
                    if (this.audioElement.paused) {
                        this.audioElement.play().catch(e => console.log('Play error:', e));
                    }
                    this.currentVolume = targetVolume;
                    this.audioElement.volume = targetVolume;
                }
            }
        }
    }

    controlMidiPlayback() {
        const normalizedSpeed = Math.min(this.motionSpeed / this.MAX_MOTION_SPEED, 1.0);
        const isMoving = normalizedSpeed >= this.motionThreshold;

        if (isMoving && !this.midiPlaybackInterval) {
            this.startMidiPlayback();
        } else if (!isMoving && this.midiPlaybackInterval) {
            this.stopMidiPlayback();
        }
    }

    startMidiPlayback() {
        if (this.midiNotes.length === 0) return;

        this.midiPlaybackInterval = setInterval(() => {
            if (this.currentNoteIndex >= this.midiNotes.length) {
                this.currentNoteIndex = 0;
            }

            const note = this.midiNotes[this.currentNoteIndex];
            this.playMidiNote(note);
            this.currentNoteIndex++;

            document.getElementById('currentNote').textContent =
                `${this.currentNoteIndex}/${this.midiNotes.length}`;

        }, 600); // Simple fixed interval for demo
    }

    stopMidiPlayback() {
        if (this.midiPlaybackInterval) {
            clearInterval(this.midiPlaybackInterval);
            this.midiPlaybackInterval = null;
        }

        // Stop any currently playing note
        this.stopCurrentMidiNote();
    }

    stopCurrentMidiNote() {
        // Stop current playing source
        if (this.currentMidiSource) {
            try {
                this.currentMidiSource.stop();
            } catch (e) {
                // Already stopped
            }
            this.currentMidiSource = null;
        }

        // Cancel scheduled stop
        if (this.noteStopTimeout) {
            clearTimeout(this.noteStopTimeout);
            this.noteStopTimeout = null;
        }
    }

    playMidiNote(note) {
        try {
            // Stop previous note immediately
            this.stopCurrentMidiNote();

            // Use violin sample with pitch shifting if loaded
            if (this.violinSampleBuffer) {
                this.playMidiNoteWithViolinSample(note);
            } else {
                // Fallback to sine wave
                this.playMidiNoteWithSineWave(note);
            }
        } catch (error) {
            console.error('Error playing MIDI note:', error);
        }
    }

    playMidiNoteWithViolinSample(note) {
        // Create buffer source
        const source = this.midiAudioContext.createBufferSource();
        source.buffer = this.violinSampleBuffer;

        // Create gain node for volume control
        const gainNode = this.midiAudioContext.createGain();

        // Calculate volume from note velocity and motion speed
        const velocityVolume = note.velocity / 127.0;
        const normalizedSpeed = Math.min(this.motionSpeed / this.MAX_MOTION_SPEED, 1.0);
        const volume = velocityVolume * normalizedSpeed * this.maxVolume;
        gainNode.gain.value = volume;

        // Calculate pitch shift rate
        // Each semitone = 2^(1/12) ≈ 1.059463
        const semitoneDistance = note.pitch - this.violinBaseNote; // note.pitch - 69 (A4)
        const rate = Math.pow(1.059463, semitoneDistance);
        const clampedRate = Math.max(0.5, Math.min(2.0, rate)); // Clamp between 0.5x and 2x
        source.playbackRate.value = clampedRate;

        // Connect nodes
        source.connect(gainNode);
        gainNode.connect(this.midiAudioContext.destination);

        // Start playing
        source.start();
        this.currentMidiSource = source;

        console.log(`Playing MIDI note ${note.pitch}: rate=${clampedRate.toFixed(3)}, volume=${volume.toFixed(3)}, duration=${note.duration}ms`);

        // Schedule stopping after note duration
        this.noteStopTimeout = setTimeout(() => {
            if (this.currentMidiSource === source) {
                try {
                    source.stop();
                } catch (e) {
                    // Already stopped
                }
                this.currentMidiSource = null;
            }
        }, note.duration);
    }

    playMidiNoteWithSineWave(note) {
        // Fallback: Simple sine wave tone generator
        const oscillator = this.midiAudioContext.createOscillator();
        const gainNode = this.midiAudioContext.createGain();

        // Convert MIDI note to frequency
        const frequency = 440 * Math.pow(2, (note.pitch - 69) / 12);
        oscillator.frequency.value = frequency;
        oscillator.type = 'sine';

        const normalizedSpeed = Math.min(this.motionSpeed / this.MAX_MOTION_SPEED, 1.0);
        const volume = normalizedSpeed * this.maxVolume;
        gainNode.gain.value = volume;

        oscillator.connect(gainNode);
        gainNode.connect(this.midiAudioContext.destination);

        oscillator.start();
        oscillator.stop(this.midiAudioContext.currentTime + note.duration / 1000);

        this.currentMidiSource = oscillator;

        console.log(`Playing MIDI note ${note.pitch} with sine wave (fallback)`);
    }

    // ===== PLAYBACK CONTROL =====

    togglePlaybackMode() {
        this.playbackMode = this.playbackMode === 'MP3' ? 'MIDI' : 'MP3';
        const btn = document.getElementById('playbackModeBtn');
        btn.textContent = this.playbackMode;
        btn.style.background = this.playbackMode === 'MIDI' ? '#8b5cf6' : '#6366f1';

        // Show/hide MIDI controls
        document.getElementById('midiControls').style.display =
            this.playbackMode === 'MIDI' ? 'block' : 'none';

        // Stop current playback
        if (this.playbackMode === 'MIDI') {
            this.audioElement.pause();
        } else {
            this.stopMidiPlayback();
        }
    }

    handleFileSelect(event) {
        const file = event.target.files[0];
        if (file) {
            console.log(`Loading MP3 file: ${file.name} (${file.size} bytes)`);

            // Check file size - warn if very large
            if (file.size > 50 * 1024 * 1024) { // 50MB
                console.warn('Large MP3 file detected');
                if (!confirm(`This file is ${Math.round(file.size / 1024 / 1024)}MB. Continue loading?`)) {
                    return;
                }
            }

            try {
                const url = URL.createObjectURL(file);
                this.loadTrack(url, file.name);
            } catch (error) {
                console.error('Error loading MP3 file:', error);
                alert(`Failed to load MP3 file: ${error.message}`);
            }
        }
    }

    handleMidiFileSelect(event) {
        const file = event.target.files[0];
        if (file) {
            document.getElementById('midiFileName').textContent = file.name;
            this.parseMidiFile(file);
        }
    }

    loadTrack(url, name) {
        try {
            // Stop current playback
            this.audioElement.pause();
            this.audioElement.currentTime = 0;

            // Revoke old object URL to free memory
            if (this.audioElement.src && this.audioElement.src.startsWith('blob:')) {
                URL.revokeObjectURL(this.audioElement.src);
            }

            // Set new source
            this.audioElement.src = url;
            this.currentTrack = name;
            document.getElementById('trackName').textContent = name;

            // Remove old listener to prevent memory leak
            this.audioElement.removeEventListener('loadedmetadata', this.onMetadataLoaded);

            // Create bound function for event listener
            this.onMetadataLoaded = () => {
                document.getElementById('duration').textContent = this.formatTime(this.audioElement.duration);
                document.getElementById('seekSlider').max = this.audioElement.duration;
                console.log(`MP3 loaded: duration=${this.audioElement.duration.toFixed(2)}s`);
            };

            // Add new listener
            this.audioElement.addEventListener('loadedmetadata', this.onMetadataLoaded);

            // Add error handler
            this.audioElement.addEventListener('error', (e) => {
                console.error('Audio loading error:', e);
                alert('Failed to load audio file. The file may be corrupted or in an unsupported format.');
            }, { once: true });

            // Auto-play if IMU playback is active
            if (this.isImuPlaying && this.characteristic) {
                this.audioElement.play().catch(e => console.log('Play error:', e));
            }

            console.log(`✅ MP3 file loaded: ${name}`);
        } catch (error) {
            console.error('Error in loadTrack:', error);
            alert(`Error loading track: ${error.message}`);
        }
    }

    toggleImuPlayback() {
        this.isImuPlaying = !this.isImuPlaying;
        const btn = document.getElementById('imuPlaybackBtn');

        if (this.isImuPlaying) {
            btn.textContent = 'Pause IMU Playback';
            btn.classList.remove('inactive');

            // Stop test playback if it's currently active
            if (this.isTestPlaying) {
                this.isTestPlaying = false;
                const testBtn = document.getElementById('testPlaybackBtn');
                testBtn.textContent = 'Test Playback (Preview)';
                testBtn.classList.remove('active');

                // Stop test playback audio
                if (this.playbackMode === 'MP3') {
                    this.audioElement.pause();
                } else {
                    this.stopMidiPlayback();
                }

                console.log('Test playback stopped (IMU playback started)');
            }

            // Start IMU playback if audio is loaded
            if (this.audioElement.src && this.playbackMode === 'MP3') {
                this.audioElement.play().catch(e => console.log('Play error:', e));
            }
        } else {
            btn.textContent = 'Play IMU Playback';
            btn.classList.add('inactive');
            if (this.playbackMode === 'MP3') {
                this.audioElement.pause();
            } else {
                this.stopMidiPlayback();
            }
        }
    }

    toggleTestPlayback() {
        this.isTestPlaying = !this.isTestPlaying;
        const btn = document.getElementById('testPlaybackBtn');

        if (this.isTestPlaying) {
            btn.textContent = 'Stop Test Playback';
            btn.classList.add('active');

            // Pause IMU playback if it's currently playing
            if (this.isImuPlaying) {
                // Directly set the state and update UI
                this.isImuPlaying = false;
                const imuBtn = document.getElementById('imuPlaybackBtn');
                imuBtn.textContent = 'Play IMU Playback';
                imuBtn.classList.add('inactive');

                // Stop any IMU-controlled playback
                if (this.playbackMode === 'MP3') {
                    this.audioElement.pause();
                } else {
                    this.stopMidiPlayback();
                }

                console.log('IMU playback paused (test playback started)');
            }

            // Start test playback
            if (this.playbackMode === 'MP3') {
                this.audioElement.volume = this.maxVolume;
                this.audioElement.play().catch(e => console.log('Play error:', e));
            } else {
                this.startMidiPlayback();
            }
        } else {
            btn.textContent = 'Test Playback (Preview)';
            btn.classList.remove('active');

            // Stop test playback
            if (this.playbackMode === 'MP3') {
                this.audioElement.pause();
            } else {
                this.stopMidiPlayback();
            }
        }
    }

    seekTo(position) {
        if (this.audioElement.src) {
            this.audioElement.currentTime = position;
        }
    }

    updatePlaybackPosition() {
        if (this.audioElement.src && !isNaN(this.audioElement.duration)) {
            document.getElementById('currentTime').textContent =
                this.formatTime(this.audioElement.currentTime);
            document.getElementById('seekSlider').value = this.audioElement.currentTime;
        }
    }

    // ===== MIDI FILE PARSING =====

    async parseMidiFile(file) {
        try {
            console.log(`Parsing MIDI file: ${file.name} (${file.size} bytes)`);

            // Check file size - warn if very large
            if (file.size > 5 * 1024 * 1024) { // 5MB
                console.warn('Large MIDI file detected, parsing may take longer');
            }

            // Read file as array buffer
            const arrayBuffer = await file.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);

            // Parse MIDI file with timeout protection
            const parsePromise = new Promise((resolve, reject) => {
                try {
                    const notes = this.parseMidiBytes(bytes);
                    resolve(notes);
                } catch (error) {
                    reject(error);
                }
            });

            // Set a timeout (10 seconds)
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('MIDI parsing timeout (10s)')), 10000);
            });

            const notes = await Promise.race([parsePromise, timeoutPromise]);

            if (notes.length > 0) {
                this.midiNotes = notes;
                this.currentNoteIndex = 0;
                document.getElementById('currentNote').textContent = `1/${this.midiNotes.length}`;
                console.log(`✅ Successfully loaded ${notes.length} notes from MIDI file`);
            } else {
                // Fallback to default scale
                console.warn('No notes found in MIDI file, using fallback scale');
                this.loadFallbackScale();
            }
        } catch (error) {
            console.error('❌ Error parsing MIDI file:', error);
            console.error('Stack trace:', error.stack);
            this.loadFallbackScale();
            alert(`Failed to parse MIDI file: ${error.message}\nUsing fallback scale instead.`);
        }
    }

    loadFallbackScale() {
        // Fallback: Create a simple violin scale (G major)
        this.midiNotes = [
            { pitch: 67, velocity: 80, duration: 500 },  // G4
            { pitch: 69, velocity: 80, duration: 500 },  // A4
            { pitch: 71, velocity: 80, duration: 500 },  // B4
            { pitch: 72, velocity: 80, duration: 500 },  // C5
            { pitch: 74, velocity: 80, duration: 500 },  // D5
            { pitch: 76, velocity: 80, duration: 500 },  // E5
            { pitch: 78, velocity: 80, duration: 500 },  // F#5
            { pitch: 79, velocity: 80, duration: 1000 }  // G5
        ];
        this.currentNoteIndex = 0;
        document.getElementById('currentNote').textContent = `1/${this.midiNotes.length}`;
        console.log('Using fallback scale with 8 notes');
    }

    parseMidiBytes(bytes) {
        const notes = [];

        console.log(`📄 Parsing MIDI bytes (${bytes.length} bytes)...`);

        try {
            // Basic MIDI file format parsing
            // MIDI files start with "MThd" header
            if (bytes.length < 14 ||
                bytes[0] !== 0x4D || // 'M'
                bytes[1] !== 0x54 || // 'T'
                bytes[2] !== 0x68 || // 'h'
                bytes[3] !== 0x64) { // 'd'
                console.error('Invalid MIDI file header');
                return [];
            }

            // Parse header
            const format = this.readInt16(bytes, 8);
            const trackCount = this.readInt16(bytes, 10);
            const division = this.readInt16(bytes, 12);

            console.log(`📋 MIDI Header: format=${format}, tracks=${trackCount}, division=${division}`);

            // Validate values
            if (trackCount < 0 || trackCount > 1000) {
                console.error(`Invalid track count: ${trackCount}`);
                return [];
            }

            // Calculate ticks per quarter note
            const ticksPerQuarter = division >= 0 ? division : 480;
            const defaultTempo = 500000; // 120 BPM default (microseconds per quarter)

            // Parse tracks
            let offset = 14;
            for (let trackNum = 0; trackNum < trackCount; trackNum++) {
                if (offset + 8 > bytes.length) break;

                // Check for track header "MTrk"
                if (bytes[offset] !== 0x4D || // 'M'
                    bytes[offset + 1] !== 0x54 || // 'T'
                    bytes[offset + 2] !== 0x72 || // 'r'
                    bytes[offset + 3] !== 0x6B) { // 'k'
                    break;
                }

                const trackLength = this.readInt32(bytes, offset + 4);
                offset += 8;
                const trackEnd = offset + trackLength;

                if (trackEnd > bytes.length) {
                    console.warn(`Track ${trackNum} length exceeds file size`);
                    break;
                }

                console.log(`🎵 Track ${trackNum}: length=${trackLength}`);

                // Parse track events
                const trackNotes = this.parseTrackEvents(bytes, offset, trackEnd, ticksPerQuarter, defaultTempo);
                notes.push(...trackNotes);

                offset = trackEnd;
            }

            console.log(`✅ Total ${notes.length} notes from ${trackCount} tracks`);

        } catch (error) {
            console.error('❌ Error in parseMidiBytes:', error);
            return [];
        }

        return notes;
    }

    parseTrackEvents(bytes, startOffset, endOffset, ticksPerQuarter, baseTempo) {
        const notes = [];
        const activeNotes = new Map(); // pitch -> {velocity, tick}

        let offset = startOffset;
        let currentTick = 0;
        let currentTempo = baseTempo;
        let runningStatus = 0;
        let loopCount = 0;
        const maxLoops = 100000; // Safety limit to prevent infinite loops

        try {
            while (offset < endOffset && offset < bytes.length) {
                // Safety check for infinite loops
                loopCount++;
                if (loopCount > maxLoops) {
                    console.warn(`MIDI parser safety limit reached (${maxLoops} iterations)`);
                    break;
                }

                // Store offset at start of iteration to detect if we're stuck
                const startOffset = offset;

                // Read variable-length delta time
                const deltaTimeResult = this.readVariableLength(bytes, offset);
                if (deltaTimeResult.bytesRead === 0) {
                    console.warn('Invalid variable-length value, stopping parse');
                    break;
                }
                const deltaTime = deltaTimeResult.value;
                offset += deltaTimeResult.bytesRead;
                currentTick += deltaTime;

                if (offset >= bytes.length || offset >= endOffset) break;

                // Get status byte
                let status = bytes[offset];
                if ((status & 0x80) === 0) {
                    // Running status - reuse last status
                    status = runningStatus;
                    if (status === 0) {
                        console.warn('Invalid running status');
                        break;
                    }
                } else {
                    offset++;
                    runningStatus = status;
                }

                if (offset >= bytes.length || offset >= endOffset) break;

                const statusType = status & 0xF0;
                const channel = status & 0x0F;

                switch (statusType) {
                    case 0x80: // Note Off
                        if (offset + 2 <= bytes.length) {
                            const pitch = bytes[offset];
                            const velocity = bytes[offset + 1];
                            offset += 2;

                            if (activeNotes.has(pitch)) {
                                const noteInfo = activeNotes.get(pitch);
                                const durationTicks = currentTick - noteInfo.tick;
                                const durationMs = this.ticksToMilliseconds(durationTicks, ticksPerQuarter, currentTempo);
                                notes.push({ pitch, velocity: noteInfo.velocity, duration: durationMs });
                                activeNotes.delete(pitch);
                            }
                        } else {
                            offset = bytes.length; // Force exit
                        }
                        break;

                    case 0x90: // Note On
                        if (offset + 2 <= bytes.length) {
                            const pitch = bytes[offset];
                            const velocity = bytes[offset + 1];
                            offset += 2;

                            if (velocity > 0) {
                                activeNotes.set(pitch, { velocity, tick: currentTick });
                            } else {
                                // Velocity 0 means note off
                                if (activeNotes.has(pitch)) {
                                    const noteInfo = activeNotes.get(pitch);
                                    const durationTicks = currentTick - noteInfo.tick;
                                    const durationMs = this.ticksToMilliseconds(durationTicks, ticksPerQuarter, currentTempo);
                                    notes.push({ pitch, velocity: noteInfo.velocity, duration: durationMs });
                                    activeNotes.delete(pitch);
                                }
                            }
                        } else {
                            offset = bytes.length; // Force exit
                        }
                        break;

                    case 0xA0: // Polyphonic Key Pressure (Aftertouch)
                        if (offset + 2 <= bytes.length) {
                            offset += 2; // Skip note and pressure
                        } else {
                            offset = bytes.length;
                        }
                        break;

                    case 0xB0: // Control Change
                        if (offset + 2 <= bytes.length) {
                            offset += 2; // Skip controller and value
                        } else {
                            offset = bytes.length;
                        }
                        break;

                    case 0xC0: // Program Change
                        if (offset + 1 <= bytes.length) {
                            offset += 1; // Skip program number
                        } else {
                            offset = bytes.length;
                        }
                        break;

                    case 0xD0: // Channel Pressure (Aftertouch)
                        if (offset + 1 <= bytes.length) {
                            offset += 1; // Skip pressure
                        } else {
                            offset = bytes.length;
                        }
                        break;

                    case 0xE0: // Pitch Bend
                        if (offset + 2 <= bytes.length) {
                            offset += 2; // Skip LSB and MSB
                        } else {
                            offset = bytes.length;
                        }
                        break;

                    case 0xF0: // System messages
                        if ((status & 0xFF) === 0xFF) {
                            // Meta event
                            if (offset < bytes.length) {
                                const metaType = bytes[offset];
                                offset++;
                                const lengthResult = this.readVariableLength(bytes, offset);
                                const length = lengthResult.value;
                                offset += lengthResult.bytesRead;

                                if (metaType === 0x51 && length >= 3 && offset + 3 <= bytes.length) {
                                    // Tempo change
                                    currentTempo = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
                                }

                                offset += length;
                            }
                        } else if ((status & 0xFF) === 0xF0 || (status & 0xFF) === 0xF7) {
                            // SysEx event
                            const lengthResult = this.readVariableLength(bytes, offset);
                            offset += lengthResult.bytesRead + lengthResult.value;
                        } else {
                            // Other system messages
                            offset++;
                        }
                        break;

                    default:
                        // Unknown event - try to skip safely
                        console.warn(`Unknown MIDI event: 0x${status.toString(16)}`);
                        offset++;
                        break;
                }

                // Safety check: ensure offset advanced
                if (offset === startOffset) {
                    console.warn('Offset did not advance, forcing increment to prevent infinite loop');
                    offset++;
                }
            }
        } catch (error) {
            console.warn('Track parsing ended:', error.message);
        }

        console.log(`Parsed ${notes.length} notes from track (${loopCount} iterations)`);
        return notes;
    }

    readVariableLength(bytes, offset) {
        let value = 0;
        let bytesRead = 0;
        let currentOffset = offset;
        let byte;

        // Safety check
        if (offset >= bytes.length) {
            return { value: 0, bytesRead: 0 };
        }

        do {
            if (currentOffset >= bytes.length) {
                console.warn('Reached end of buffer while reading variable-length value');
                break;
            }
            byte = bytes[currentOffset++];
            bytesRead++;
            value = (value << 7) | (byte & 0x7F);

            // Safety limit
            if (bytesRead >= 4 && (byte & 0x80) !== 0) {
                console.warn('Variable-length value exceeded 4 bytes');
                break;
            }
        } while ((byte & 0x80) !== 0 && bytesRead < 4);

        return { value, bytesRead };
    }

    readInt16(bytes, offset) {
        return (bytes[offset] << 8) | bytes[offset + 1];
    }

    readInt32(bytes, offset) {
        return (bytes[offset] << 24) | (bytes[offset + 1] << 16) |
               (bytes[offset + 2] << 8) | bytes[offset + 3];
    }

    ticksToMilliseconds(ticks, ticksPerQuarter, microsecondsPerQuarter) {
        // Convert MIDI ticks to milliseconds
        // Formula: (ticks / ticksPerQuarter) * (microsecondsPerQuarter / 1000)
        const quarters = ticks / ticksPerQuarter;
        const microseconds = quarters * microsecondsPerQuarter;
        const milliseconds = Math.floor(microseconds / 1000);
        return Math.max(milliseconds, 100); // Minimum 100ms duration
    }

    // ===== BUILT-IN TRACKS =====

    loadDefaultTracks() {
        // Load default MP3: Hysilens' Unfinished Melody
        if (window.ASSETS_MANIFEST && window.ASSETS_MANIFEST.mp3) {
            const defaultMp3 = window.ASSETS_MANIFEST.mp3.find(item =>
                item.name.toLowerCase().includes('unfinished') &&
                item.name.toLowerCase().includes('melody')
            );

            if (defaultMp3) {
                const url = `assets/mp3/${defaultMp3.file}`;
                this.loadTrack(url, defaultMp3.name);
                console.log(`✅ Loaded default MP3: ${defaultMp3.name}`);
            } else {
                console.log('ℹ️ Default MP3 not found in manifest');
            }
        }

        // Load default MIDI: Unfinished Melody
        if (window.ASSETS_MANIFEST && window.ASSETS_MANIFEST.midi) {
            const defaultMidi = window.ASSETS_MANIFEST.midi.find(item =>
                item.name.toLowerCase().includes('unfinished')
            );

            if (defaultMidi) {
                const url = `assets/midi/${defaultMidi.file}`;
                this.loadMidiFromUrl(url, defaultMidi.name);
                console.log(`✅ Loaded default MIDI: ${defaultMidi.name}`);
            } else {
                console.log('ℹ️ Default MIDI not found in manifest');
            }
        }
    }

    showBuiltInTracks() {
        // Load tracks dynamically from assets manifest
        const tracks = [];

        if (window.ASSETS_MANIFEST && window.ASSETS_MANIFEST.mp3) {
            window.ASSETS_MANIFEST.mp3.forEach(item => {
                tracks.push({
                    name: item.name,
                    url: `assets/mp3/${item.file}`
                });
            });
        }

        const tracksList = document.getElementById('tracksList');
        tracksList.innerHTML = '';

        if (tracks.length === 0) {
            tracksList.innerHTML = `
                <div style="padding: 20px; text-align: center; color: #94a3b8;">
                    <p>No MP3 files found</p>
                    <p style="font-size: 0.9rem; margin-top: 10px;">
                        Add MP3 files to <code>assets/mp3/</code> folder<br>
                        and list them in <code>assets/manifest.js</code>
                    </p>
                </div>
            `;
            this.showModal('tracksModal');
            return;
        }

        tracks.forEach(track => {
            const trackItem = document.createElement('div');
            trackItem.className = 'track-item';
            trackItem.textContent = track.name;
            trackItem.addEventListener('click', () => {
                this.loadTrack(track.url, track.name);
                this.closeModal('tracksModal');
            });
            tracksList.appendChild(trackItem);
        });

        this.showModal('tracksModal');
    }

    showBuiltInMidiFiles() {
        // Load MIDI files dynamically from assets manifest
        const midiFiles = [];

        if (window.ASSETS_MANIFEST && window.ASSETS_MANIFEST.midi) {
            window.ASSETS_MANIFEST.midi.forEach(item => {
                midiFiles.push({
                    name: item.name,
                    url: `assets/midi/${item.file}`
                });
            });
        }

        const midiList = document.getElementById('midiList');
        midiList.innerHTML = '';

        if (midiFiles.length === 0) {
            midiList.innerHTML = `
                <div style="padding: 20px; text-align: center; color: #94a3b8;">
                    <p>No MIDI files found</p>
                    <p style="font-size: 0.9rem; margin-top: 10px;">
                        Add MIDI files to <code>assets/midi/</code> folder<br>
                        and list them in <code>assets/manifest.js</code>
                    </p>
                </div>
            `;
            this.showModal('midiModal');
            return;
        }

        midiFiles.forEach(midiFile => {
            const midiItem = document.createElement('div');
            midiItem.className = 'track-item';
            midiItem.textContent = midiFile.name;
            midiItem.addEventListener('click', () => {
                this.loadMidiFromUrl(midiFile.url, midiFile.name);
                this.closeModal('midiModal');
            });
            midiList.appendChild(midiItem);
        });

        this.showModal('midiModal');
    }

    async loadMidiFromUrl(url, name) {
        try {
            document.getElementById('midiFileName').textContent = name;
            const response = await fetch(url);
            const blob = await response.blob();
            const file = new File([blob], name, { type: 'audio/midi' });
            await this.parseMidiFile(file);
            console.log(`Loaded MIDI file: ${name}`);
        } catch (error) {
            console.error('Error loading MIDI file:', error);
            document.getElementById('midiFileName').textContent = 'Error loading MIDI file';
        }
    }

    // ===== UI UPDATES =====

    updateStatus(status) {
        const statusElement = document.getElementById('connectionStatus');
        statusElement.textContent = status;

        if (status.includes('Connected')) {
            statusElement.classList.add('connected');
            statusElement.classList.remove('connecting');
        } else if (status.includes('Connecting') || status.includes('Auto-reconnecting')) {
            statusElement.classList.add('connecting');
            statusElement.classList.remove('connected');
        } else {
            statusElement.classList.remove('connected', 'connecting');
        }
    }

    updateImuDisplay() {
        document.getElementById('accelX').textContent = this.imuData.ax.toFixed(2);
        document.getElementById('accelY').textContent = this.imuData.ay.toFixed(2);
        document.getElementById('accelZ').textContent = this.imuData.az.toFixed(2);
        document.getElementById('gyroX').textContent = this.imuData.gx.toFixed(2);
        document.getElementById('gyroY').textContent = this.imuData.gy.toFixed(2);
        document.getElementById('gyroZ').textContent = this.imuData.gz.toFixed(2);
        document.getElementById('motionSpeed').textContent = this.motionSpeed.toFixed(2);

        const motionProgress = Math.min((this.motionSpeed / 300) * 100, 100);
        document.getElementById('motionProgress').style.width = motionProgress + '%';

        const directionElement = document.getElementById('bowDirection');
        directionElement.textContent = this.bowDirection;
        directionElement.className = 'direction-value';
        if (this.bowDirection.includes('Up')) {
            directionElement.classList.add('up-bow');
        } else if (this.bowDirection.includes('Down')) {
            directionElement.classList.add('down-bow');
        }

        const volumePercent = Math.round(this.currentVolume * 100);
        document.getElementById('currentVolumeValue').textContent = volumePercent;
        document.getElementById('volumeProgress').style.width = volumePercent + '%';
    }

    updateRawOutput() {
        const outputElement = document.getElementById('rawOutput');
        outputElement.innerHTML = this.rawOutputLines.join('<br>');
        outputElement.scrollTop = outputElement.scrollHeight;
    }

    updateUI() {
        // Initial UI state
        document.getElementById('maxVolumeValue').textContent = Math.round(this.maxVolume * 100);
        document.getElementById('motionThresholdValue').textContent = Math.round(this.motionThreshold * 100);
    }

    // ===== MODALS =====

    showModal(modalId) {
        document.getElementById(modalId).classList.add('active');
    }

    closeModal(modalId) {
        document.getElementById(modalId).classList.remove('active');
    }

    // ===== SAVED CONNECTION =====

    saveConnection(deviceId, deviceName, serviceUuid, characteristicUuid) {
        const connection = {
            deviceId,
            deviceName,
            serviceUuid,
            characteristicUuid
        };
        localStorage.setItem('violinPlayerConnection', JSON.stringify(connection));
        this.savedConnection = connection;
    }

    loadSavedConnection() {
        const saved = localStorage.getItem('violinPlayerConnection');
        return saved ? JSON.parse(saved) : null;
    }

    // ===== HELPER FUNCTIONS =====

    formatTime(seconds) {
        if (isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    getServiceName(uuid) {
        const services = {
            '00001800-0000-1000-8000-00805f9b34fb': 'Generic Access',
            '00001801-0000-1000-8000-00805f9b34fb': 'Generic Attribute',
            '0000180a-0000-1000-8000-00805f9b34fb': 'Device Information',
            '0000180f-0000-1000-8000-00805f9b34fb': 'Battery Service'
        };
        return services[uuid.toLowerCase()] || 'Custom Service';
    }

    getCharacteristicName(uuid) {
        const characteristics = {
            '00002a00-0000-1000-8000-00805f9b34fb': 'Device Name',
            '00002a01-0000-1000-8000-00805f9b34fb': 'Appearance',
            '00002a19-0000-1000-8000-00805f9b34fb': 'Battery Level'
        };
        return characteristics[uuid.toLowerCase()] || 'Custom Characteristic';
    }

    getPropertiesString(properties) {
        const props = [];
        if (properties.read) props.push('READ');
        if (properties.write) props.push('WRITE');
        if (properties.writeWithoutResponse) props.push('WRITE_NO_RESPONSE');
        if (properties.notify) props.push('NOTIFY');
        if (properties.indicate) props.push('INDICATE');
        return props.join(', ');
    }
}

// Initialize the app when the page loads
window.addEventListener('DOMContentLoaded', () => {
    // Check for Web Bluetooth support
    if (!navigator.bluetooth) {
        alert('Web Bluetooth API is not supported in this browser. Please use Chrome or Edge.');
        return;
    }

    // Create the violin player instance
    window.violinPlayer = new ViolinPlayer();
});

