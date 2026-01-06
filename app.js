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
        this.arduinoVolumeFeedbackEnabled = true; // Toggle for sending volume to Arduino
        this.arduinoMaxVolumeScale = 1.0; // Scale factor for Arduino volume (0.0 - 1.0)
        this.startIMUPlaybackOnConnect = false; // Whether to start IMU playback on connect
        
        // Idle mode (Arduino LED animation when not playing)
        this.idleMode = false; // Whether idle mode is active
        this.idleTransitionTimeout = null; // Timeout before entering idle mode
        this.idleAnimationInterval = null; // Interval for idle wave animation
        this.idleStartTime = 0; // When idle mode started
        this.lastIdleVolume = 0; // Last volume sent in idle mode

        // Audio
        this.audioContext = null;
        this.audioElement = null;
        this.audioSource = null;
        this.audioGainNode = null; // For fallback volume control
        this.volumeSupported = true; // Browser volume support flag
        this.usingWebAudioVolume = false; // Flag for Web Audio volume control
        this.needsWebAudioVolume = false; // Flag to setup Web Audio when audio loads
        this.currentTrack = null;
        this.isTestPlaying = false;
        this.isImuPlaying = false; // Default to false - starts paused until Bluetooth connected
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
        this.isPlayingMidiSequence = false; // Track if MIDI sequence is playing
        this.midiAudioContext = null;

        // Violin sample for MIDI playback
        this.violinSampleBuffer = null; // AudioBuffer for violin_a4.wav
        this.violinBaseNote = 69; // A4 = MIDI note 69
        this.currentMidiSource = null; // Current playing note source
        this.currentMidiGainNode = null; // Current MIDI gain node for live volume updates
        this.currentNoteVelocity = null; // Current note velocity for recalculation
        this.noteStopTimeout = null; // Timeout to stop note after duration

        // Settings
        this.maxVolume = 1.0;
        this.motionThreshold = 0.15; // 15%
        this.currentVolume = 0;

        // Fade tracking (smooth transitions between volume levels)
        this.isFading = false;
        this.fadeStartTime = 0;
        this.fadeStartVolume = 0;
        this.fadeTargetVolume = 0;
        this.fadeInDuration = 500; // fade-in duration
        this.fadeOutDuration = 30; // fade-out duration (faster)

        // Volume smoothing (moving average filter for smoother transitions)
        this.volumeHistory = [];
        this.volumeHistorySize = 5; // Average last 5 volume values
        this.smoothedVolume = 0;

        // Constants
        this.MAX_MOTION_SPEED = 250.0;

        // Saved connection info
        this.savedConnection = this.loadSavedConnection();

        // Console log history
        this.consoleHistory = [];
        this.maxConsoleLines = 100;
        
        // Audio cache
        this.AUDIO_CACHE_NAME = 'hysilens-audio-cache-v1';
        this.cacheInitialized = false;

        this.init();
    }

    init() {
        this.setupConsoleInterceptor();
        this.setupWindowErrorHandlers();
        this.setupAudio();
        this.setupEventListeners();
        this.updateUI();

        // Load default tracks
        this.loadDefaultTracks();
        
        // Initialize audio cache and preload files
        this.initAudioCache();

        // Attempt auto-reconnect after short delay
        setTimeout(() => this.attemptAutoReconnect(), 1000);
    }

    // ===== BUTTON STATE UTILITY FUNCTIONS =====

    /**
     * Update IMU Playback button state
     * @param {boolean} isPlaying - Whether IMU playback is active
     */
    updateImuPlaybackButton(isPlaying) {
        const btn = document.getElementById('imuPlaybackBtn');
        if (!btn) return;

        if (isPlaying) {
            btn.textContent = 'Pause IMU Playback';
            btn.classList.remove('inactive');
            btn.classList.add('active');
        } else {
            btn.textContent = 'Play IMU Playback';
            btn.classList.remove('active');
            btn.classList.add('inactive');
        }
    }

    /**
     * Update Test Playback button state
     * @param {boolean} isPlaying - Whether test playback is active
     */
    updateTestPlaybackButton(isPlaying) {
        const btn = document.getElementById('testPlaybackBtn');
        if (!btn) return;

        if (isPlaying) {
            btn.textContent = 'Stop Test Playback';
            btn.classList.add('active');
        } else {
            btn.textContent = 'Test Playback (Preview)';
            btn.classList.remove('active');
        }
    }

    // ===== AUDIO SETUP =====

    setupAudio() {
        console.log('=== Audio Setup: Browser Compatibility Check ===');

        // Detect browser info
        const userAgent = navigator.userAgent;
        console.log('User Agent:', userAgent);
        console.log('Platform:', navigator.platform);

        // Check AudioContext support
        const hasAudioContext = !!(window.AudioContext || window.webkitAudioContext);
        console.log('AudioContext supported:', hasAudioContext ? 'YES ✅' : 'NO ❌');

        if (hasAudioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            console.log('AudioContext created successfully');
            console.log('  - State:', this.audioContext.state);
            console.log('  - Sample rate:', this.audioContext.sampleRate + ' Hz');
            console.log('  - Base latency:', this.audioContext.baseLatency || 'N/A');
        } else {
            console.error('AudioContext NOT available');
        }

        this.audioElement = new Audio();
        this.audioElement.loop = false; // Default: loop disabled

        // Enable background audio playback for iOS
        // This prevents audio from stopping when browser is minimized or screen is off
        this.audioElement.setAttribute('playsinline', '');
        this.audioElement.setAttribute('webkit-playsinline', '');

        // Handle song end when loop is disabled
        this.audioElement.addEventListener('ended', async () => {
            // Only act if loop is disabled
            if (!this.audioElement.loop) {
                // Turn off IMU playback if active
                if (this.isImuPlaying) {
                    console.log('🔚 Song ended with loop disabled - turning off IMU playback');
                    this.isImuPlaying = false;
                    this.updateImuPlaybackButton(false);
                    
                    // Handle idle mode transition
                    if (this.currentVolume > 0) {
                        await this.fadeArduinoVolumeToZero(1000);
                    }
                    this.scheduleIdleModeTransition();
                }

                // Turn off test playback if active
                if (this.isTestPlaying) {
                    console.log('🔚 Song ended with loop disabled - turning off test playback');
                    this.isTestPlaying = false;
                    this.updateTestPlaybackButton(false);
                    
                    // Handle idle mode transition
                    if (this.currentVolume > 0) {
                        await this.fadeArduinoVolumeToZero(1000);
                    }
                    this.scheduleIdleModeTransition();
                }
            }
        });

        // Set audio element to not pause on background (iOS Safari)
        if ('mediaSession' in navigator) {
            // Enable media session for background playback
            this.setupMediaSession();
        }

        console.log('Audio element created:', !!this.audioElement ? 'YES ✅' : 'NO ❌');

        this.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        console.log('iOS detected:', this.isIOS ? 'YES ✅' : 'NO ❌');

        // Setup background audio support
        this.setupBackgroundAudioSupport();

        // Check if volume control is supported
        this.volumeSupported = this.checkVolumeSupport();
        if (this.isIOS) {
            this.volumeSupported = false;
        }
        console.log('HTML5 volume control supported:', this.volumeSupported ? 'YES ✅' : 'NO ❌');

        // Check Web Audio API features for gain workaround
        console.log('--- Web Audio API Features ---');
        if (hasAudioContext && this.audioContext) {
            const hasCreateMediaElementSource = typeof this.audioContext.createMediaElementSource === 'function';
            const hasCreateGain = typeof this.audioContext.createGain === 'function';
            const hasDestination = !!this.audioContext.destination;

            console.log('createMediaElementSource:', hasCreateMediaElementSource ? 'YES ✅' : 'NO ❌');
            console.log('createGain:', hasCreateGain ? 'YES ✅' : 'NO ❌');
            console.log('destination node:', hasDestination ? 'YES ✅' : 'NO ❌');

            if (hasCreateMediaElementSource && hasCreateGain && hasDestination) {
                console.log('Web Audio API gain workaround: AVAILABLE ✅');
                console.log('  Note: Will be setup after audio loads');
            } else {
                console.warn('Web Audio API gain workaround: INCOMPLETE ⚠️');
                if (!hasCreateMediaElementSource) console.warn('  - Missing: createMediaElementSource');
                if (!hasCreateGain) console.warn('  - Missing: createGain');
                if (!hasDestination) console.warn('  - Missing: destination');
            }
        } else {
            console.error('Web Audio API gain workaround: NOT AVAILABLE ❌');
        }

        console.log('--- Volume Control Strategy ---');
        // When volume not supported, prepare for Web Audio API
        // Note: We can't create MediaElementSource until audio has a source
        if (!this.volumeSupported) {
            this.needsWebAudioVolume = true;
            console.log('🔊 SELECTED: Web Audio API gain workaround');
            console.log('  Reason:', this.isIOS ? 'iOS device detected' : 'HTML5 volume not writable');
            console.log('  Status: Will setup after audio loads');
        } else {
            console.log('🔊 SELECTED: Standard HTML5 volume control');
            console.log('  Reason: Desktop browser with working volume property');
        }

        console.log('=======================================');

        // Set initial volume (with compatibility check)
        this.setAudioVolume(0); // Start muted

        // Setup audio context for MIDI with violin sample
        this.midiAudioContext = new (window.AudioContext || window.webkitAudioContext)();

        // Load violin_a4.wav sample for MIDI playback
        this.loadViolinSample();

        // Log compatibility info
        if (!this.volumeSupported) {
            console.warn('⚠️ Will use Web Audio API gain node for volume control (unsupported browser)');
        }
    }

    // Check if browser supports HTML5 audio volume control
    checkVolumeSupport() {
        try {
            const testAudio = new Audio();
            // Some mobile browsers and older browsers don't support volume
            if (typeof testAudio.volume === 'undefined') {
                return false;
            }

            // Try to set volume to test if it's writable
            const originalVolume = testAudio.volume;
            testAudio.volume = 0.5;
            const volumeChanged = testAudio.volume === 0.5;
            testAudio.volume = originalVolume;

            return volumeChanged;
        } catch (e) {
            console.warn('Volume support check failed:', e);
            return false;
        }
    }

    // Setup Web Audio API for volume control (required for unsupported browsers)
    async setupWebAudioVolume() {
        console.log('=== Setting up Web Audio Volume Control ===');
        try {
            // Check if audio element has a source (required for MediaElementSource)
            console.log('Step 1: Checking audio element...');
            console.log('  - Audio element exists:', !!this.audioElement);
            console.log('  - Audio element src:', this.audioElement?.src || 'NONE');

            if (!this.audioElement || !this.audioElement.src) {
                console.warn('⚠️ Cannot setup Web Audio yet: audio element has no source');
                console.log('Result: FAILED (no audio source)');
                console.log('========================================');
                return false;
            }
            console.log('  ✅ Audio element has source');

            // Check AudioContext state
            console.log('Step 2: Checking AudioContext...');
            console.log('  - AudioContext exists:', !!this.audioContext);
            console.log('  - AudioContext state:', this.audioContext?.state);

            // Resume AudioContext on iOS (required due to autoplay policy)
            if (this.audioContext.state === 'suspended') {
                console.log('  - AudioContext is suspended, attempting to resume...');
                await this.audioContext.resume();
                console.log('  - After resume, state:', this.audioContext.state);

                if (this.audioContext.state === 'running') {
                    console.log('  ✅ AudioContext resumed successfully');
                } else {
                    console.warn('  ⚠️ AudioContext state:', this.audioContext.state);
                }
            } else {
                console.log('  ✅ AudioContext already running');
            }

            // Create MediaElementSource from audio element (can only be done once!)
            console.log('Step 3: Creating MediaElementSource...');
            if (!this.audioSource) {
                try {
                    this.audioSource = this.audioContext.createMediaElementSource(this.audioElement);
                    console.log('  ✅ MediaElementSource created successfully');
                } catch (e) {
                    console.error('  ❌ Failed to create MediaElementSource:', e.message);
                    throw e;
                }
            } else {
                console.log('  ℹ️ MediaElementSource already exists (reusing)');
            }

            // Create gain node for volume control
            console.log('Step 4: Creating GainNode...');
            if (!this.audioGainNode) {
                try {
                    this.audioGainNode = this.audioContext.createGain();
                    this.audioGainNode.gain.value = 0; // Start muted
                    console.log('  ✅ GainNode created successfully');
                    console.log('  - Initial gain value:', this.audioGainNode.gain.value);
                } catch (e) {
                    console.error('  ❌ Failed to create GainNode:', e.message);
                    throw e;
                }
            } else {
                console.log('  ℹ️ GainNode already exists (reusing)');
            }

            // Connect: audio element → source → gain → destination
            console.log('Step 5: Connecting audio graph...');
            if (this.audioSource && this.audioGainNode) {
                try {
                    this.audioSource.connect(this.audioGainNode);
                    console.log('  ✅ Connected: MediaElementSource → GainNode');

                    this.audioGainNode.connect(this.audioContext.destination);
                    console.log('  ✅ Connected: GainNode → AudioDestination');

                    console.log('  ✅ Complete audio graph connected');
                } catch (e) {
                    console.error('  ❌ Failed to connect audio graph:', e.message);
                    throw e;
                }
            } else {
                console.error('  ❌ Missing nodes for connection');
                throw new Error('Audio source or gain node is missing');
            }

            // Mark that we're using Web Audio API for volume
            this.usingWebAudioVolume = true;
            console.log('✅ Web Audio volume control ready!');
            console.log('========================================');
            return true;

        } catch (e) {
            console.error('❌ Failed to setup Web Audio API volume control');
            console.error('Error:', e.message);
            console.error('Stack:', e.stack);
            this.usingWebAudioVolume = false;
            console.log('Result: FAILED');
            console.log('========================================');
            return false;
        }
    }

    // Setup background audio support for iOS
    setupBackgroundAudioSupport() {
        console.log('=== Setting up Background Audio Support ===');

        // Handle visibility change events
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                console.log('📱 App minimized/backgrounded');
                // Keep audio playing - don't pause
                if (this.isImuPlaying && this.audioElement.src && this.audioElement.paused) {
                    console.log('🔊 Resuming audio in background');
                    this.audioElement.play().catch(e => console.log('Background play error:', e));
                }
            } else {
                console.log('📱 App foregrounded');
                // Resume AudioContext if suspended
                if (this.audioContext && this.audioContext.state === 'suspended') {
                    this.audioContext.resume().then(() => {
                        console.log('🔊 AudioContext resumed on foreground');
                    });
                }
            }
        });

        // Handle page hide/show events (iOS specific)
        window.addEventListener('pagehide', (e) => {
            console.log('📱 Page hidden');
            // Don't stop audio on page hide
        });

        window.addEventListener('pageshow', (e) => {
            console.log('📱 Page shown');
            if (e.persisted) {
                // Page was restored from cache
                console.log('📱 Page restored from cache');
                if (this.isImuPlaying && this.audioElement.src && this.audioElement.paused) {
                    this.audioElement.play().catch(err => console.log('Resume error:', err));
                }
            }
        });

        // Prevent audio from stopping when screen locks (iOS Safari)
        // Request wake lock if available
        if ('wakeLock' in navigator) {
            this.requestWakeLock();
        }

        console.log('✅ Background audio support configured');
        console.log('========================================');
    }

    // Setup Media Session API for background audio controls
    setupMediaSession() {
        if (!('mediaSession' in navigator)) {
            console.log('Media Session API not supported');
            return;
        }

        console.log('=== Setting up Media Session API ===');

        // Set metadata
        navigator.mediaSession.metadata = new MediaMetadata({
            title: 'Hysilens Violin Player',
            artist: 'IMU Motion Control',
            album: 'Violin Performance',
            artwork: []
        });

        // Set up action handlers
        navigator.mediaSession.setActionHandler('play', () => {
            console.log('Media Session: Play');
            if (!this.isImuPlaying) {
                this.toggleImuPlayback();
            }
        });

        navigator.mediaSession.setActionHandler('pause', () => {
            console.log('Media Session: Pause');
            if (this.isImuPlaying) {
                this.toggleImuPlayback();
            }
        });

        navigator.mediaSession.setActionHandler('stop', () => {
            console.log('Media Session: Stop');
            if (this.isImuPlaying) {
                this.toggleImuPlayback();
            }
        });

        // Seek handlers
        navigator.mediaSession.setActionHandler('seekto', (details) => {
            console.log('Media Session: Seek to', details.seekTime);
            if (this.audioElement.src) {
                this.audioElement.currentTime = details.seekTime;
            }
        });

        console.log('✅ Media Session API configured');
    }

    // Request wake lock to keep screen and audio active
    async requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                this.wakeLock = await navigator.wakeLock.request('screen');
                console.log('✅ Wake Lock acquired');

                // Re-acquire wake lock when visibility changes
                this.wakeLock.addEventListener('release', () => {
                    console.log('Wake Lock released');
                });

                // Re-request on visibility change
                document.addEventListener('visibilitychange', async () => {
                    if (!document.hidden && this.isImuPlaying) {
                        try {
                            this.wakeLock = await navigator.wakeLock.request('screen');
                            console.log('✅ Wake Lock re-acquired');
                        } catch (e) {
                            console.log('Wake Lock re-acquire failed:', e.message);
                        }
                    }
                });
            }
        } catch (err) {
            console.log('Wake Lock not available:', err.message);
        }
    }

    // Safely set audio volume with fallbacks for older browsers
    setAudioVolume(volume, isForceSet = false) {
        // Clamp volume between 0 and 1
        const clampedVolume = Math.max(0, Math.min(1, volume));

        // Track previous volume for Arduino updates
        const previousVolume = this.currentVolume || 0;
        this.currentVolume = clampedVolume;

        // Only log on significant volume changes (not every slider movement)
        const shouldLog = !this.lastLoggedVolume || Math.abs(clampedVolume - this.lastLoggedVolume) > 0.05;

        // Send to Arduino logic:
        // - Send when volume drops to 0 from non-zero (transition to mute)
        // - Send when volume reaches maximum (1.0) from non-max (transition to max)
        // - Send on significant changes (>2% difference) for other values
        // - Don't send continuously when already at 0 or already at max
        const isTransitionToZero = clampedVolume === 0 && previousVolume > 0;
        const isTransitionToMax = clampedVolume === 1.0 && previousVolume < 1.0;
        const isSignificantChange = Math.abs(clampedVolume - previousVolume) > 0.02;
        const shouldSendToArduino = isForceSet || isTransitionToZero || isTransitionToMax || (clampedVolume > 0 && clampedVolume < 1.0 && isSignificantChange);

        try {
            // When using Web Audio volume, use gain node with smooth ramping
            if (this.usingWebAudioVolume && this.audioGainNode) {
                this.setGainWithRamp(this.audioGainNode, clampedVolume);
//                if (shouldLog) {
//                    console.log(`🔊 Volume set via Web Audio gain: ${(clampedVolume * 100).toFixed(0)}%`);
//                    console.log('  Method: Web Audio API GainNode (smooth ramp)');
//                    console.log('  Gain value:', clampedVolume.toFixed(3));
//                    this.lastLoggedVolume = clampedVolume;
//                }

                // Send to Arduino
                if (shouldSendToArduino) {
                    this.sendVolumeToArduino();
                }
                return true;
            }

            // Try standard HTML5 volume property (desktop browsers)
            if (this.audioElement && typeof this.audioElement.volume !== 'undefined') {
                const before = this.audioElement.volume;
                this.audioElement.volume = clampedVolume;
                const after = this.audioElement.volume;

//                if (shouldLog) {
//                    console.log(`🔊 Volume set via HTML5: ${(clampedVolume * 100).toFixed(0)}%`);
//                    console.log('  Method: HTML5 Audio.volume property');
//                    console.log('  Requested:', clampedVolume.toFixed(3));
//                    console.log('  Actual:', after.toFixed(3));
//
//                    if (Math.abs(after - clampedVolume) > 0.01) {
//                        console.warn('  ⚠️ Volume may not be controllable (iOS?)');
//                    }
//                    this.lastLoggedVolume = clampedVolume;
//                }
            }

            // Fallback: Use Web Audio API gain node if available
            if (!this.volumeSupported && this.audioContext) {
                if (shouldLog) {
                    console.log(`🔊 Using fallback Web Audio gain`);
                }
                this.useWebAudioGain(clampedVolume);
            }

            // Send to Arduino
            if (shouldSendToArduino) {
                this.sendVolumeToArduino();
            }

            return true;
        } catch (e) {
            console.error('❌ Failed to set audio volume:', e.message);
            console.error('Volume requested:', clampedVolume);
            return false;
        }
    }

    // Smoothly transition to target volume with fade (for 0 to volume or volume to 0 transitions)
    smoothSetAudioVolume(targetVolume) {
        const clampedTarget = Math.max(0, Math.min(1, targetVolume));
        const currentVol = this.currentVolume || 0;

        // Check if we need to start a new fade
        const isFadingFromZero = currentVol < 0.01 && clampedTarget > 0.01;
        const isFadingToZero = currentVol > 0.01 && clampedTarget < 0.01;
        
        // Check if fade is enabled (duration > 0)
        const fadeInEnabled = this.fadeInDuration > 0;
        const fadeOutEnabled = this.fadeOutDuration > 0;
        
        const shouldFade = (isFadingFromZero && fadeInEnabled) || (isFadingToZero && fadeOutEnabled);

        if (shouldFade && !this.isFading) {
            // Start new fade
            this.isFading = true;
            this.fadeStartTime = Date.now();
            this.fadeStartVolume = currentVol;
            this.fadeTargetVolume = clampedTarget;
            this.currentFadeDirection = isFadingFromZero ? 'in' : 'out';

            // Clear volume history when starting fade to avoid smoothing lag
            this.volumeHistory = [];
            this.smoothedVolume = currentVol;

            const fadeType = isFadingFromZero ? 'fade-in' : 'fade-out';
            console.log(`🎵 Starting ${fadeType} from ${(currentVol * 100).toFixed(0)}% to ${(clampedTarget * 100).toFixed(0)}%`);
        }

        let volumeToSet;

        // Apply fade if active
        if (this.isFading) {
            // Dynamically update target if it changed during fade
            const targetChanged = Math.abs(this.fadeTargetVolume - clampedTarget) > 0.02;
            if (targetChanged) {
                // Update target smoothly without restarting fade
                this.fadeTargetVolume = clampedTarget;
            }

            const elapsed = Date.now() - this.fadeStartTime;
            const fadeDuration = this.currentFadeDirection === 'in' ? this.fadeInDuration : this.fadeOutDuration;
            const progress = fadeDuration > 0 ? Math.min(elapsed / fadeDuration, 1.0) : 1.0;

            // Different easing curves for fade-in vs fade-out
            let easedProgress;
            if (this.currentFadeDirection === 'out') {
                // Faster fade-out with exponential curve (steeper drop)
                easedProgress = 1 - Math.pow(1 - progress, 20);
            } else {
                // Smooth ease-in-out for fade-in
                if (progress < 0.5) {
                    easedProgress = 2 * progress * progress;
                } else {
                    easedProgress = 1 - 2 * Math.pow(1 - progress, 2);
                }
            }

            // Calculate intermediate volume
            const volumeRange = this.fadeTargetVolume - this.fadeStartVolume;
            const fadeVolume = this.fadeStartVolume + (volumeRange * easedProgress);

            volumeToSet = fadeVolume;

            // Check if we should stop early
            // Stop fade early if we've reached the target or if direction changed
            const reachedTarget = Math.abs(currentVol - clampedTarget) < 0.01;
            const directionChanged =
                (this.fadeStartVolume < clampedTarget && currentVol > clampedTarget) ||
                (this.fadeStartVolume > clampedTarget && currentVol < clampedTarget);

            // Also stop if we're close enough to target and target stopped changing
            const closeEnough = Math.abs(currentVol - clampedTarget) < 0.05 && !targetChanged;

            if (progress >= 1.0 || reachedTarget || directionChanged || closeEnough) {
                this.isFading = false;
                // Set to current target, not original target
                volumeToSet = clampedTarget;
                if (progress < 1.0) {
                    console.log(`⏹️ Fade stopped early at ${(clampedTarget * 100).toFixed(0)}% (was targeting ${(this.fadeTargetVolume * 100).toFixed(0)}%)`);
                } else {
                    console.log(`✅ Fade complete at ${(clampedTarget * 100).toFixed(0)}%`);
                }
            }
        } else if (!shouldFade) {
            // No fade needed, set directly
            volumeToSet = clampedTarget;
        } else {
            // Waiting to start fade, use current
            volumeToSet = currentVol;
        }

        // Apply volume smoothing (moving average filter) for all volume changes
        // This creates smoother transitions by averaging recent volume values
        this.volumeHistory.push(volumeToSet);
        if (this.volumeHistory.length > this.volumeHistorySize) {
            this.volumeHistory.shift();
        }

        // Calculate smoothed volume (average of history)
        const sum = this.volumeHistory.reduce((a, b) => a + b, 0);
        this.smoothedVolume = sum / this.volumeHistory.length;

        // Apply the smoothed volume
        this.setAudioVolume(this.smoothedVolume);
    }

    // Set gain value with smooth exponential ramping to prevent clicks/pops
    setGainWithRamp(gainNode, targetVolume, rampTime = 0.015) {
        try {
            if (!gainNode || !gainNode.gain) {
                console.warn('setGainWithRamp: Invalid gain node');
                return;
            }

            const currentTime = this.audioContext.currentTime;
            const currentValue = gainNode.gain.value;

            // Cancel any scheduled parameter changes
            gainNode.gain.cancelScheduledValues(currentTime);

            // Set current value explicitly
            gainNode.gain.setValueAtTime(currentValue, currentTime);

            // Handle zero values specially to prevent exponentialRamp errors
            if (targetVolume < 0.001) {
                // Ramp to very small value, then to zero
                gainNode.gain.exponentialRampToValueAtTime(0.001, currentTime + rampTime * 0.8);
                gainNode.gain.linearRampToValueAtTime(0, currentTime + rampTime);
            } else if (currentValue < 0.001) {
                // Ramp from very small value
                gainNode.gain.setValueAtTime(0.001, currentTime);
                gainNode.gain.exponentialRampToValueAtTime(Math.max(targetVolume, 0.001), currentTime + rampTime);
            } else {
                // Normal exponential ramp (smooth and natural sounding)
                gainNode.gain.exponentialRampToValueAtTime(Math.max(targetVolume, 0.001), currentTime + rampTime);
            }
        } catch (e) {
            console.warn('Failed to set gain with ramp, falling back to direct value:', e.message);
            // Fallback to direct value setting if ramping fails
            gainNode.gain.value = targetVolume;
        }
    }

    // Fallback method using Web Audio API for volume control
    useWebAudioGain(volume) {
        try {
            // Create gain node if not exists
            if (!this.audioGainNode) {
                // Create MediaElementSource if not exists
                if (!this.audioSource && this.audioElement) {
                    this.audioSource = this.audioContext.createMediaElementSource(this.audioElement);
                }

                if (!this.audioGainNode) {
                    this.audioGainNode = this.audioContext.createGain();
                }

                // Connect: source → gain → destination
                if (this.audioSource && this.audioGainNode) {
                    this.audioSource.connect(this.audioGainNode);
                    this.audioGainNode.connect(this.audioContext.destination);
                }
            }

            // Set gain value with smooth ramping to prevent clicks/pops
            if (this.audioGainNode && this.audioGainNode.gain) {
                this.setGainWithRamp(this.audioGainNode, volume);
            }
        } catch (e) {
            console.warn('Web Audio API gain fallback failed:', e);
        }
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

    // ===== CONSOLE INTERCEPTOR =====

    setupConsoleInterceptor() {
        // Store original console methods
        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalError = console.error;
        const originalInfo = console.info;

        // Override console.log
        console.log = (...args) => {
            originalLog.apply(console, args);
            this.addConsoleMessage('log', args);
        };

        // Override console.warn
        console.warn = (...args) => {
            originalWarn.apply(console, args);
            this.addConsoleMessage('warn', args);
        };

        // Override console.error
        console.error = (...args) => {
            originalError.apply(console, args);
            this.addConsoleMessage('error', args);
        };

        // Override console.info
        console.info = (...args) => {
            originalInfo.apply(console, args);
            this.addConsoleMessage('info', args);
        };
    }

    addConsoleMessage(type, args) {
        const timestamp = new Date().toLocaleTimeString();
        const message = args.map(arg => {
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg);
                } catch (e) {
                    return String(arg);
                }
            }
            return String(arg);
        }).join(' ');

        // Add to history
        this.consoleHistory.push({ type, timestamp, message });

        // Limit history size
        if (this.consoleHistory.length > this.maxConsoleLines) {
            this.consoleHistory.shift();
        }

        // Update display
        this.updateConsoleDisplay();
    }

    updateConsoleDisplay() {
        const consoleOutput = document.getElementById('consoleOutput');
        if (!consoleOutput) return;

        consoleOutput.innerHTML = this.consoleHistory.map(log => `
            <div class="console-log">
                <span class="console-log-time">${log.timestamp}</span>
                <span class="console-log-type ${log.type}">${log.type.toUpperCase()}</span>
                <span class="console-log-message">${this.escapeHtml(log.message)}</span>
            </div>
        `).join('');

        // Auto-scroll to bottom
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }

    clearConsole() {
        this.consoleHistory = [];
        this.updateConsoleDisplay();
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ===== WINDOW ERROR HANDLERS =====

    setupWindowErrorHandlers() {
        // Catch uncaught JavaScript errors
        window.addEventListener('error', (event) => {
            const errorMsg = event.error
                ? `${event.error.name}: ${event.error.message}\n  at ${event.filename}:${event.lineno}:${event.colno}`
                : `${event.message}\n  at ${event.filename}:${event.lineno}:${event.colno}`;

            console.error('Uncaught error:', errorMsg);

            // Don't prevent default error handling
            return false;
        });

        // Catch unhandled promise rejections
        window.addEventListener('unhandledrejection', (event) => {
            const reason = event.reason;
            const errorMsg = reason instanceof Error
                ? `${reason.name}: ${reason.message}\n  ${reason.stack || ''}`
                : String(reason);

            console.error('Unhandled promise rejection:', errorMsg);

            // Don't prevent default handling
            return false;
        });

        console.log('Window error handlers initialized');
    }

    // ===== EVENT LISTENERS =====

    setupEventListeners() {
        // Connection buttons
        document.getElementById('connectBtn').addEventListener('click', () => this.connectDevice());
        document.getElementById('disconnectBtn').addEventListener('click', () => this.disconnect());

        // Playback mode buttons
        document.getElementById('mp3ModeBtn').addEventListener('click', () => this.setPlaybackMode('MP3'));
        document.getElementById('midiModeBtn').addEventListener('click', () => this.setPlaybackMode('MIDI'));

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

        // Restart with delay
        document.getElementById('restartWithDelayBtn').addEventListener('click', () => this.restartWithDelay());

        // Seek slider
        document.getElementById('seekSlider').addEventListener('input', (e) => this.seekTo(e.target.value));

        // Volume controls
        document.getElementById('maxVolumeSlider').addEventListener('input', (e) => {
            this.maxVolume = e.target.value / 100;
            document.getElementById('maxVolumeValue').textContent = e.target.value;

            // Update volume live during test playback
            if (this.isTestPlaying) {
                if (this.playbackMode === 'MP3') {
                    // Update MP3 volume immediately
                    this.setAudioVolume(this.maxVolume);
                } else if (this.playbackMode === 'MIDI' && this.currentMidiGainNode && this.currentNoteVelocity !== null) {
                    // Update MIDI gain node volume with smooth ramping
                    const newVolume = this.currentNoteVelocity * this.maxVolume;
                    this.setGainWithRamp(this.currentMidiGainNode, newVolume, 0.01);
                }
            }
        });

        document.getElementById('motionThresholdSlider').addEventListener('input', (e) => {
            this.motionThreshold = e.target.value / 100;
            document.getElementById('motionThresholdValue').textContent = e.target.value;
        });

        // Loop Toggle
        document.getElementById('loopToggle').addEventListener('change', (e) => {
            this.audioElement.loop = e.target.checked;
            console.log(`🔁 Loop playback ${e.target.checked ? 'enabled' : 'disabled'}`);
        });

        // Arduino Volume Feedback Toggle
        document.getElementById('arduinoVolumeFeedbackToggle').addEventListener('change', (e) => this.toggleArduinoVolumeFeedback(e.target.checked));

        // Arduino Max Volume Scale
        document.getElementById('arduinoMaxVolumeSlider').addEventListener('input', (e) => {
            this.arduinoMaxVolumeScale = e.target.value / 100;
            document.getElementById('arduinoMaxVolumeValue').textContent = e.target.value;
        });

        document.getElementById('arduinoMaxVolumeSlider').addEventListener('change', (e) => {
            console.log(`🔊 Arduino volume scale set to: ${e.target.value}% (scale: ${this.arduinoMaxVolumeScale.toFixed(2)})`);
        });

        // Fade In Duration
        document.getElementById('fadeInDurationSlider').addEventListener('input', (e) => {
            this.fadeInDuration = parseInt(e.target.value);
            document.getElementById('fadeInDurationValue').textContent = e.target.value;
        });

        document.getElementById('fadeInDurationSlider').addEventListener('change', (e) => {
            console.log(`🎵 Fade-in duration set to: ${e.target.value}ms`);
        });

        // Fade Out Duration
        document.getElementById('fadeOutDurationSlider').addEventListener('input', (e) => {
            this.fadeOutDuration = parseInt(e.target.value);
            document.getElementById('fadeOutDurationValue').textContent = e.target.value;
        });

        document.getElementById('fadeOutDurationSlider').addEventListener('change', (e) => {
            console.log(`🎵 Fade-out duration set to: ${e.target.value}ms`);
        });

        // Service modal
        document.getElementById('closeServiceModal').addEventListener('click', () => this.closeModal('serviceModal'));

        // Console controls
        document.getElementById('clearConsoleBtn').addEventListener('click', () => this.clearConsole());
        document.getElementById('toggleConsoleBtn').addEventListener('click', () => {
            const consoleOutput = document.getElementById('consoleOutput');
            const toggleBtn = document.getElementById('toggleConsoleBtn');
            consoleOutput.classList.toggle('collapsed');
            toggleBtn.textContent = consoleOutput.classList.contains('collapsed') ? 'Expand' : 'Collapse';
        });

        // Update playback position
        setInterval(() => this.updatePlaybackPosition(), 100);
    }

    // ===== AUDIO CACHE =====
    
    async initAudioCache() {
        if (!('caches' in window)) {
            console.warn('Cache API not supported in this browser');
            return;
        }
        
        try {
            const cache = await caches.open(this.AUDIO_CACHE_NAME);
            this.cacheInitialized = true;
            console.log('✅ Audio cache initialized');
            
            // Preload all audio files in background
            this.preloadAudioFiles();
        } catch (error) {
            console.error('Failed to initialize audio cache:', error);
        }
    }
    
    async preloadAudioFiles() {
        if (!this.cacheInitialized || !window.ASSETS_MANIFEST) return;
        
        console.log('📦 Starting background audio preload...');
        
        const filesToCache = [];
        
        // Collect all MP3 files
        if (window.ASSETS_MANIFEST.mp3) {
            window.ASSETS_MANIFEST.mp3.forEach(item => {
                filesToCache.push(`assets/mp3/${item.file}`);
            });
        }
        
        // Collect all MIDI files
        if (window.ASSETS_MANIFEST.midi) {
            window.ASSETS_MANIFEST.midi.forEach(item => {
                filesToCache.push(`assets/midi/${item.file}`);
            });
        }
        
        let cachedCount = 0;
        let skippedCount = 0;
        
        try {
            const cache = await caches.open(this.AUDIO_CACHE_NAME);
            
            // Check which files are already cached
            for (const url of filesToCache) {
                const cached = await cache.match(url);
                if (cached) {
                    skippedCount++;
                } else {
                    // Cache in background without blocking
                    cache.add(url).then(() => {
                        cachedCount++;
                        console.log(`📥 Cached: ${url.split('/').pop()}`);
                    }).catch(err => {
                        console.warn(`Failed to cache ${url}:`, err.message);
                    });
                }
            }
            
            console.log(`📦 Preload complete: ${skippedCount} already cached, ${filesToCache.length - skippedCount} queued for caching`);
        } catch (error) {
            console.error('Error during audio preload:', error);
        }
    }
    
    async getCachedAudio(url) {
        if (!this.cacheInitialized) return null;
        
        try {
            const cache = await caches.open(this.AUDIO_CACHE_NAME);
            const response = await cache.match(url);
            
            if (response) {
                console.log(`💾 Loaded from cache: ${url.split('/').pop()}`);
                return response;
            }
        } catch (error) {
            console.warn('Cache lookup failed:', error);
        }
        
        return null;
    }
    
    async cacheAudio(url) {
        if (!this.cacheInitialized) return;
        
        try {
            const cache = await caches.open(this.AUDIO_CACHE_NAME);
            await cache.add(url);
            console.log(`💾 Cached: ${url.split('/').pop()}`);
        } catch (error) {
            console.warn('Failed to cache audio:', error);
        }
    }
    
    async clearAudioCache() {
        try {
            const deleted = await caches.delete(this.AUDIO_CACHE_NAME);
            if (deleted) {
                console.log('🗑️ Audio cache cleared');
                this.cacheInitialized = false;
            }
            return deleted;
        } catch (error) {
            console.error('Failed to clear cache:', error);
            return false;
        }
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
                optionalServices: commonServices,
//                filters: [{ service: commonServices }]
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

        // Only pause audio if test playback is NOT active
        if (this.audioElement && !this.isTestPlaying) {
            this.forcePause();
            console.log('Audio paused (Bluetooth disconnected, test playback not active)');
        } else if (this.isTestPlaying) {
            console.log('Test playback active - keeping audio playing');
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

            // Send initial volume level to Arduino
            this.sendVolumeToArduino();

            // Stop test playback if it's running
            if (this.isTestPlaying) {
                this.isTestPlaying = false;
                this.updateTestPlaybackButton(false);

                // Stop test playback audio
                if (this.playbackMode === 'MP3') {
                    this.forcePause();
                } else {
                    this.stopMidiPlayback();
                }

                console.log('Test playback stopped (IMU playback auto-started)');
            }

            if (this.startIMUPlaybackOnConnect) {
                // Automatically start IMU playback after successful connection
                console.log('🎵 Auto-starting IMU playback after Bluetooth connection...');
                this.isImuPlaying = true;
                this.updateImuPlaybackButton(true);

                // Start audio if track is loaded
                if (this.audioElement.src) {
                    // Resume AudioContext if needed
                    if (this.audioContext.state === 'suspended') {
                        console.log('🔊 Resuming AudioContext...');
                        await this.audioContext.resume();
                    }

                    // Setup Web Audio API if needed
                    if (this.needsWebAudioVolume && !this.usingWebAudioVolume) {
                        console.log('🔊 Setting up Web Audio API...');
                        await this.setupWebAudioVolume();
                    }

                    // Start playback
                    this.audioElement.play().catch(e => console.log('Audio play error:', e));
                    console.log('✅ IMU playback auto-started!');
                } else {
                    console.log('ℹ️ IMU playback enabled, waiting for audio track to be loaded');
                }
            } else {
                // Start idle mode animation by default after connection
                console.log('🌙 Starting idle mode animation after Bluetooth connection...');
                this.startIdleMode();
            }

        } catch (error) {
            console.error('Subscription error:', error);
            this.updateStatus('Subscription failed: ' + error.message);
        }
    }

    // Send current volume level to Arduino (0-100)
    async sendVolumeToArduino() {
        if (!this.characteristic) {
            console.warn('⚠️ Cannot send volume: No characteristic connected');
            return false;
        }

        // Check if Arduino volume feedback is enabled
        if (!this.arduinoVolumeFeedbackEnabled) {
            return false; // Silently skip if disabled
        }
        
        // Don't send actual volume if in idle mode
        if (this.idleMode) {
            return false; // Idle animation handles volume sending
        }

        try {
            // Check if characteristic supports write
            const canWrite = this.characteristic.properties.write ||
                           this.characteristic.properties.writeWithoutResponse;

            if (!canWrite) {
                console.warn('⚠️ Characteristic does not support writing');
                return false;
            }

            // Calculate volume as 0-100 with Arduino max volume scaling
            const scaledVolume = this.currentVolume * this.arduinoMaxVolumeScale;
            const volumePercent = Math.round(scaledVolume * 100);

            // Create data packet: "VOL:XX\n" format
            const message = `VOL:${volumePercent}\n`;
            const encoder = new TextEncoder();
            const data = encoder.encode(message);

            // Send to Arduino
            if (this.characteristic.properties.writeWithoutResponse) {
                await this.characteristic.writeValueWithoutResponse(data);
            } else {
                await this.characteristic.writeValue(data);
            }

//            console.log(`📡 Sent volume to Arduino: ${volumePercent}%`);
            return true;

        } catch (error) {
//            console.error('❌ Failed to send volume to Arduino:', error.message);
            return false;
        }
    }

    // Send a specific volume value to Arduino (for toggle on/off)
    async sendSpecificVolumeToArduino(volumePercent) {
        if (!this.characteristic) {
            console.warn('⚠️ Cannot send volume: No characteristic connected');
            return false;
        }

        try {
            // Check if characteristic supports write
            const canWrite = this.characteristic.properties.write ||
                           this.characteristic.properties.writeWithoutResponse;

            if (!canWrite) {
                console.warn('⚠️ Characteristic does not support writing');
                return false;
            }

            // Create data packet: "VOL:XX\n" format
            const message = `VOL:${volumePercent}\n`;
            const encoder = new TextEncoder();
            const data = encoder.encode(message);

            // Send to Arduino
            if (this.characteristic.properties.writeWithoutResponse) {
                await this.characteristic.writeValueWithoutResponse(data);
            } else {
                await this.characteristic.writeValue(data);
            }

//            console.log(`📡 Sent volume to Arduino: ${volumePercent}% (Toggle)`);
            return true;

        } catch (error) {
//            console.error('❌ Failed to send volume to Arduino:', error.message);
            return false;
        }
    }

    // Start idle mode with transition
    async startIdleMode() {
        if (this.idleMode) return; // Already in idle mode
        
        this.idleMode = true;
        this.idleStartTime = Date.now();
        this.lastIdleVolume = 0;
        
        console.log('🌙 Entering idle mode...');
        
        // Clear any existing transition timeout
        if (this.idleTransitionTimeout) {
            clearTimeout(this.idleTransitionTimeout);
            this.idleTransitionTimeout = null;
        }
        
        // Start idle animation
        this.runIdleAnimation();
    }
    
    // Stop idle mode
    stopIdleMode() {
        this.idleMode = false;

        console.log('☀️ Exiting idle mode');

        // Clear idle animation interval
        if (this.idleAnimationInterval) {
            clearInterval(this.idleAnimationInterval);
            this.idleAnimationInterval = null;
        }
        
        // Clear any pending transition
        if (this.idleTransitionTimeout) {
            clearTimeout(this.idleTransitionTimeout);
            this.idleTransitionTimeout = null;
        }
    }
    
    // Run idle mode animation
    async runIdleAnimation() {
        // Clear any existing animation
        if (this.idleAnimationInterval) {
            clearInterval(this.idleAnimationInterval);
        }
        
        const animate = async () => {
            if (!this.idleMode) return;
            
            const elapsed = Date.now() - this.idleStartTime;
            
            let targetVolume;
            
            if (elapsed < 3000) {
                // First 3 seconds: transition from 0 to 100
                const progress = elapsed / 3000;
                targetVolume = Math.round(progress * 100);
            } else {
                // After 3 seconds: wave from 100 to 75 to 100 every 4 seconds
                const waveTime = (elapsed - 3000) % 4000;
                const waveProgress = waveTime / 4000;
                
                // Sine wave from 100 to 20 to 100
                const waveValue = 60 + 40 * Math.cos(waveProgress * Math.PI * 2);
                targetVolume = Math.round(waveValue);
            }
            
            // Only send if volume changed
            if (targetVolume !== this.lastIdleVolume) {
                await this.sendSpecificVolumeToArduino(targetVolume);
                this.lastIdleVolume = targetVolume;
            }
        };
        
        // Run immediately
        await animate();
        
        // Then run every 50ms for smooth animation
        this.idleAnimationInterval = setInterval(animate, 50);
    }
    
    // Schedule transition to idle mode
    scheduleIdleModeTransition() {
        // Clear any existing timeout
        if (this.idleTransitionTimeout) {
            clearTimeout(this.idleTransitionTimeout);
            this.idleTransitionTimeout = null;
        }
        
        // Otherwise, schedule transition after 5 seconds
        console.log('⏱️ Scheduling idle mode transition in 5 seconds...');
        this.idleTransitionTimeout = setTimeout(() => {
            this.startIdleMode();
        }, 5000);
    }
    
    // Gradually fade Arduino volume to 0 over specified duration
    async fadeArduinoVolumeToZero(durationMs = 1000) {
        const startVolume = Math.round(this.currentVolume * this.arduinoMaxVolumeScale * 100);
        const startTime = Date.now();
        
        console.log(`📉 Fading Arduino volume from ${startVolume}% to 0% over ${durationMs}ms...`);
        
        const fade = async () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / durationMs, 1.0);
            
            // Ease-out curve for smooth fade
            const easedProgress = 1 - Math.pow(1 - progress, 2);
            const currentVolume = Math.round(startVolume * (1 - easedProgress));
            
            await this.sendSpecificVolumeToArduino(currentVolume);
            
            if (progress < 1.0) {
                // Continue fading
                setTimeout(fade, 30);
            } else {
                console.log('✅ Arduino volume fade complete');
            }
        };
        
        await fade();
    }
    
    // Toggle Arduino volume feedback on/off
    // When turned off, set volume to 100 to ensure LED is always on
    async toggleArduinoVolumeFeedback(isChecked) {
        this.arduinoVolumeFeedbackEnabled = isChecked;

        if (this.arduinoVolumeFeedbackEnabled) {
            // Resume normal volume updates
            console.log('✅ Arduino volume feedback enabled');
            this.sendVolumeToArduino();
        } else {
            // Disabled: Send 100% volume
            console.log('❌ Arduino volume feedback disabled');

            // Send 0% to Arduino
            await this.sendSpecificVolumeToArduino(100);
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

        // Only pause audio if test playback is NOT active
        if (this.audioElement && !this.isTestPlaying) {
            this.forcePause();
            console.log('Audio paused (Bluetooth disconnected, test playback not active)');
        } else if (this.isTestPlaying) {
            console.log('Test playback active - keeping audio playing');
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
                // Above threshold: Full volume (with gradual fade-in if coming from 0)
                if (this.audioElement.paused) {
                    this.audioElement.play().catch(e => console.log('Play error:', e));
                }
                this.smoothSetAudioVolume(this.maxVolume);

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
                    // Fade to 0, but only pause once volume actually reaches 0
                    this.smoothSetAudioVolume(0);

                    // Check if smoothed volume has reached 0 before pausing
                    if (this.smoothedVolume < 0.01 && !this.audioElement.paused) {
                        this.forcePause();
                        console.log('🔇 Audio paused after fade-out complete');
                        this.setAudioVolume(0, true); // Ensure volume is set to 0
                        // Send volume 0 to Arduino after 0.5 seconds when pausing after fade-out
                        setTimeout(async () => {
                            if (this.audioElement.paused && this.currentVolume === 0) {
                                await this.sendSpecificVolumeToArduino(0);
                            }
                        }, 500);
                    }
                } else {
                    if (this.audioElement.paused) {
                        this.audioElement.play().catch(e => console.log('Play error:', e));
                    }
                    this.smoothSetAudioVolume(targetVolume); // Gradual fade-in if coming from 0
                }
            }
        }
    }

    controlMidiPlayback() {
        const normalizedSpeed = Math.min(this.motionSpeed / this.MAX_MOTION_SPEED, 1.0);
        const isMoving = normalizedSpeed >= this.motionThreshold;

        if (isMoving && !this.isPlayingMidiSequence) {
            this.startContinuousMidiPlayback();
        } else if (!isMoving && this.isPlayingMidiSequence) {
            this.stopContinuousMidiPlayback();
        }
    }

    async startContinuousMidiPlayback() {
        if (this.isPlayingMidiSequence || this.midiNotes.length === 0) {
            return;
        }

        this.isPlayingMidiSequence = true;
        console.log('Starting continuous MIDI playback (motion above threshold)');

        // Main playback loop
        while (this.isPlayingMidiSequence) {
            // Check if still in MIDI mode and IMU is active
            if (this.playbackMode !== 'MIDI' || !this.isImuPlaying) {
                break;
            }

            // Get current note
            if (this.currentNoteIndex >= this.midiNotes.length) {
                this.currentNoteIndex = 0; // Loop back
            }

            const note = this.midiNotes[this.currentNoteIndex];
            console.log(`Playing note ${this.currentNoteIndex + 1}/${this.midiNotes.length}: pitch=${note.pitch}, duration=${note.duration}ms`);

            // Play the note
            this.playMidiNote(note);

            // Update UI
            document.getElementById('currentNote').textContent =
                `${this.currentNoteIndex + 1}/${this.midiNotes.length}`;

            // Wait for note duration before playing next note
            await this.sleep(note.duration);

            // Move to next note
            this.currentNoteIndex++;
        }

        this.isPlayingMidiSequence = false;
        console.log('Continuous MIDI playback stopped');
    }

    stopContinuousMidiPlayback() {
        this.isPlayingMidiSequence = false;
        this.stopCurrentMidiNote();
        console.log('Stopping continuous MIDI playback');
    }

    // For test playback - plays notes sequentially based on their duration
    async startTestMidiPlayback() {
        if (this.midiNotes.length === 0) {
            console.warn('No MIDI notes loaded');
            return;
        }

        this.isPlayingMidiSequence = true;
        this.currentNoteIndex = 0;

        await this.playNextMidiNoteInSequence();
    }

    async playNextMidiNoteInSequence() {
        if (!this.isTestPlaying) {
            console.log('Test playback stopped, stopping sequence');
            this.isPlayingMidiSequence = false;
            return;
        }

        if (this.midiNotes.length === 0) {
            console.warn('No MIDI notes loaded');
            return;
        }

        // Check if we've reached the end
        if (this.currentNoteIndex >= this.midiNotes.length) {
            // Loop back to start
            this.currentNoteIndex = 0;
            console.log('Reached end, looping back to start');
        }

        const note = this.midiNotes[this.currentNoteIndex];
        console.log(`Test playback note ${this.currentNoteIndex + 1}/${this.midiNotes.length}: pitch=${note.pitch}, duration=${note.duration}ms`);

        // Play the note
        this.playMidiNote(note);

        // Update UI
        document.getElementById('currentNote').textContent =
            `${this.currentNoteIndex + 1}/${this.midiNotes.length}`;

        // Wait for note duration
        await this.sleep(note.duration);

        // Move to next note
        this.currentNoteIndex++;

        // Play next note
        if (this.isTestPlaying) {
            await this.playNextMidiNoteInSequence();
        } else {
            this.isPlayingMidiSequence = false;
        }
    }

    stopMidiPlayback() {
        this.isPlayingMidiSequence = false;
        this.stopCurrentMidiNote();
    }

    // Helper function to sleep/delay
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
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

        // Clear gain node and velocity references
        this.currentMidiGainNode = null;
        this.currentNoteVelocity = null;

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

        // Use max volume for test playback, motion-controlled volume for IMU playback
        let volume;
        if (this.isTestPlaying) {
            // Test playback: use max volume
            volume = velocityVolume * this.maxVolume;
        } else {
            // IMU playback: use motion speed
            const normalizedSpeed = Math.min(this.motionSpeed / this.MAX_MOTION_SPEED, 1.0);
            volume = velocityVolume * normalizedSpeed * this.maxVolume;
        }

        // Set initial gain value (start at volume, will ramp in if needed)
        gainNode.gain.setValueAtTime(Math.max(volume, 0.001), this.midiAudioContext.currentTime);

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
        this.currentMidiGainNode = gainNode; // Store gain node for live volume updates
        this.currentNoteVelocity = velocityVolume; // Store velocity for recalculation

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
                this.currentMidiGainNode = null;
                this.currentNoteVelocity = null;
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

        // Use max volume for test playback, motion-controlled volume for IMU playback
        let volume;
        if (this.isTestPlaying) {
            // Test playback: use max volume
            volume = this.maxVolume;
            this.currentNoteVelocity = 1.0; // Store for recalculation
        } else {
            // IMU playback: use motion speed
            const normalizedSpeed = Math.min(this.motionSpeed / this.MAX_MOTION_SPEED, 1.0);
            volume = normalizedSpeed * this.maxVolume;
        }

        // Set initial gain value (start at volume, will ramp in if needed)
        gainNode.gain.setValueAtTime(Math.max(volume, 0.001), this.midiAudioContext.currentTime);

        oscillator.connect(gainNode);
        gainNode.connect(this.midiAudioContext.destination);

        oscillator.start();
        oscillator.stop(this.midiAudioContext.currentTime + note.duration / 1000);

        this.currentMidiSource = oscillator;
        this.currentMidiGainNode = gainNode; // Store gain node for live volume updates

        console.log(`Playing MIDI note ${note.pitch} with sine wave (fallback), volume=${volume.toFixed(3)}`);
    }

    // ===== PLAYBACK CONTROL =====

    setPlaybackMode(mode) {
        // Only change if it's different
        if (this.playbackMode === mode) {
            return;
        }

        this.playbackMode = mode;

        // Update button states
        const mp3Btn = document.getElementById('mp3ModeBtn');
        const midiBtn = document.getElementById('midiModeBtn');

        if (mode === 'MP3') {
            mp3Btn.classList.add('active');
            midiBtn.classList.remove('active');
        } else {
            mp3Btn.classList.remove('active');
            midiBtn.classList.add('active');
        }

        // Show/hide MIDI controls
        document.getElementById('mp3Controls').style.display =
            this.playbackMode === 'MP3' ? 'block' : 'none';

        // Show/hide MIDI controls
        document.getElementById('midiControls').style.display =
            this.playbackMode === 'MIDI' ? 'block' : 'none';

        // Stop current playback
        if (this.playbackMode === 'MIDI') {
            this.forcePause();
        } else {
            this.stopMidiPlayback();
        }

        console.log(`🎵 Playback mode changed to: ${mode}`);
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

    async loadTrack(url, name) {
        try {
            // Stop current playback
            this.forcePause();
            this.audioElement.currentTime = 0;

            // Revoke old object URL to free memory
            if (this.audioElement.src && this.audioElement.src.startsWith('blob:')) {
                URL.revokeObjectURL(this.audioElement.src);
            }

            // Try to load from cache first
            let audioUrl = url;
            const cachedResponse = await this.getCachedAudio(url);
            
            if (cachedResponse) {
                // Create blob URL from cached response
                const blob = await cachedResponse.blob();
                audioUrl = URL.createObjectURL(blob);
            } else {
                // Not in cache, will fetch from network and cache it
                console.log(`🌐 Loading from network: ${url.split('/').pop()}`);
                this.cacheAudio(url); // Cache in background
            }

            // Set new source
            this.audioElement.src = audioUrl;
            this.currentTrack = name;
            document.getElementById('trackName').textContent = name;

            // Remove old listener to prevent memory leak
            this.audioElement.removeEventListener('loadedmetadata', this.onMetadataLoaded);

            // Create bound function for event listener
            this.onMetadataLoaded = async () => {
                document.getElementById('duration').textContent = this.formatTime(this.audioElement.duration);
                document.getElementById('seekSlider').max = this.audioElement.duration;
                console.log(`MP3 loaded: duration=${this.audioElement.duration.toFixed(2)}s`);

                // Setup Web Audio API for unsupported browsers after audio source is loaded
                if (this.needsWebAudioVolume && !this.usingWebAudioVolume) {
                    console.log('🔊 Setting up Web Audio API for unsupported browsers...');
                    await this.setupWebAudioVolume();
                }
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

            // Auto-play if test playback is active
            if (this.isTestPlaying && this.playbackMode === 'MP3') {
                console.log('🔊 Resuming test playback with new track');
                this.setAudioVolume(this.maxVolume);
                this.audioElement.play().catch(e => console.log('Play error:', e));
            }

            console.log(`✅ MP3 file loaded: ${name}`);
        } catch (error) {
            console.error('Error in loadTrack:', error);
            alert(`Error loading track: ${error.message}`);
        }
    }

    async forcePause() {
        this.audioElement.pause();
        const lastTime = this.audioElement.currentTime;
        this.audioElement.load(); // Reset the audio element
        this.audioElement.currentTime = lastTime;
    }

    async toggleImuPlayback() {
        this.isImuPlaying = !this.isImuPlaying;
        this.updateImuPlaybackButton(this.isImuPlaying);

        if (this.isImuPlaying) {
            // Exit idle mode when starting playback
            this.stopIdleMode();
            
            // Stop test playback if it's currently active
            if (this.isTestPlaying) {
                this.isTestPlaying = false;
                this.updateTestPlaybackButton(false);

                // Stop test playback audio
                if (this.playbackMode === 'MP3') {
                    this.forcePause();
                } else {
                    this.stopMidiPlayback();
                }

                console.log('Test playback stopped (IMU playback started)');
            }

            // Resume AudioContext on unsupported browsers if needed
            if (this.audioContext.state === 'suspended') {
                console.log('🔊 Resuming AudioContext for unsupported browsers...');
                await this.audioContext.resume();
            }

            // Setup Web Audio API if needed (for unsupported browsers or when volume not supported)
            if (this.needsWebAudioVolume && !this.usingWebAudioVolume && this.audioElement.src) {
                console.log('🔊 Setting up Web Audio API for IMU playback...');
                await this.setupWebAudioVolume();
            }

            // Start IMU playback if audio is loaded
            if (this.audioElement.src && this.playbackMode === 'MP3') {
                this.audioElement.play().catch(e => console.log('Play error:', e));
            }
        } else {
            if (this.playbackMode === 'MP3') {
                this.forcePause();
            } else {
                this.stopMidiPlayback();
            }
            
            // Handle idle mode transition when stopping
            if (this.currentVolume > 0) {
                await this.fadeArduinoVolumeToZero(1000);
            }
            this.scheduleIdleModeTransition();
        }
    }

    async toggleTestPlayback() {
        this.isTestPlaying = !this.isTestPlaying;
        this.updateTestPlaybackButton(this.isTestPlaying);

        if (this.isTestPlaying) {
            // Exit idle mode when starting test playback
            this.stopIdleMode();
            
            // Pause IMU playback if it's currently playing
            if (this.isImuPlaying) {
                // Directly set the state and update UI
                this.isImuPlaying = false;
                this.updateImuPlaybackButton(false);

                // Stop any IMU-controlled playback
                if (this.playbackMode === 'MP3') {
                    this.forcePause();
                } else {
                    this.stopMidiPlayback();
                }

                console.log('IMU playback paused (test playback started)');
            }

            // Resume AudioContext on unsupported browsers if needed
            if (this.audioContext.state === 'suspended') {
                console.log('🔊 Resuming AudioContext for unsupported browsers...');
                await this.audioContext.resume();
            }

            // Start test playback
            this.sendSpecificVolumeToArduino(100);
            if (this.playbackMode === 'MP3') {
                this.setAudioVolume(this.maxVolume);
                this.audioElement.play().catch(e => console.log('Play error:', e));
            } else {
                this.startTestMidiPlayback();
            }
        } else {
            // Stop test playback
            if (this.playbackMode === 'MP3') {
                this.forcePause();
            } else {
                this.stopMidiPlayback();
            }
            
            // Handle idle mode transition when stopping
            if (this.currentVolume > 0) {
                await this.fadeArduinoVolumeToZero(1000);
            }
            this.scheduleIdleModeTransition();
        }
    }

    seekTo(position) {
        if (this.audioElement.src) {
            this.audioElement.currentTime = position;
        }
    }

    async restartWithDelay() {
        console.log('=== Restart with Delay Started ===');

        // Get delay time from input
        const delayInput = document.getElementById('restartDelayInput');
        const delaySeconds = parseFloat(delayInput.value) || 3;

        if (delaySeconds < 0 || delaySeconds > 60) {
            console.error('Delay must be between 0 and 60 seconds');
            alert('Please enter a delay between 0 and 60 seconds');
            return;
        }

        const btn = document.getElementById('restartWithDelayBtn');

        try {
            // Disable button during process
            btn.disabled = true;
            btn.textContent = 'Restarting...';

            // Stop any current playback
            if (this.isTestPlaying) {
                this.isTestPlaying = false;
                this.updateTestPlaybackButton(false);
            }

            // Stop IMU playback if active
            if (this.isImuPlaying) {
                this.isImuPlaying = false;
                this.updateImuPlaybackButton(false);
            }

            // Pause audio and reset position
            if (this.playbackMode === 'MP3') {
                this.forcePause();
                this.audioElement.currentTime = 0;
                console.log('🔄 Song restarted to position 0');
            } else {
                this.stopMidiPlayback();
                console.log('🔄 MIDI playback stopped');
            }

            // Stop MIDI if in MIDI mode
            if (this.playbackMode === 'MIDI') {
                this.stopMidiPlayback();
            }

            // Update UI to show waiting
            btn.textContent = `Waiting ${delaySeconds}s...`;

            // Wait for the specified delay
            console.log(`⏳ Waiting ${delaySeconds} seconds before starting IMU playback...`);

            // Exit idle mode when starting with delay
            this.stopIdleMode();
            this.sendSpecificVolumeToArduino(0);

            // Countdown display
            for (let i = delaySeconds; i > 0; i--) {
                btn.textContent = `Starting in ${i}s...`;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            // Resume AudioContext on unsupported browsers if needed
            if (this.audioContext.state === 'suspended') {
                console.log('🔊 Resuming AudioContext for unsupported browsers...');
                await this.audioContext.resume();
            }

            // Setup Web Audio API if needed
            if (this.needsWebAudioVolume && !this.usingWebAudioVolume && this.audioElement.src) {
                console.log('🔊 Setting up Web Audio API for IMU playback...');
                await this.setupWebAudioVolume();
            }

            // Start IMU playback
            this.isImuPlaying = true;
            this.updateImuPlaybackButton(true);

            // Start audio playback if track is loaded
            if (this.audioElement.src && this.playbackMode === 'MP3') {
                this.audioElement.play().catch(e => console.log('Play error:', e));
                console.log('✅ IMU playback started!');
            } else if (this.playbackMode === 'MIDI') {
                console.log('✅ IMU MIDI playback ready!');
            }

            // Reset button
            btn.textContent = 'Restart, Wait, & Start IMU';
            console.log('=== Restart with Delay Complete ===');

        } catch (error) {
            console.error('❌ Error during restart with delay:', error);
            btn.textContent = 'Restart, Wait, & Start IMU';
            alert(`Error: ${error.message}`);
        } finally {
            // Re-enable button
            btn.disabled = false;
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

        // Show warning if volume control is not supported
        if (!this.volumeSupported) {
            const volumeSection = document.querySelector('.volume-section');
            if (volumeSection) {
                const warning = document.createElement('div');
                warning.className = 'compatibility-warning';
                warning.innerHTML = `
                    <span class="warning-icon">⚠️</span>
                    <span>Volume control may be limited on this browser. Using alternative methods.</span>
                `;
                volumeSection.insertBefore(warning, volumeSection.firstChild.nextSibling);
            }
        }
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
//        return;
    }

    // Create the violin player instance
    window.violinPlayer = new ViolinPlayer();
});

