document.addEventListener('DOMContentLoaded', () => {
    const room = new WebsimSocket();

    // --- DOM Elements ---
    const voiceSelector = document.querySelector('.voice-selector');
    const messageContainer = document.querySelector('.message-container');
    const chatArea = document.querySelector('.chat-area');
    const statusText = document.getElementById('status-text');
    const statusLoader = document.querySelector('.status .loader');
    const userInput = document.getElementById('user-input');
    const micButton = document.getElementById('mic-button');
    const sendButton = document.getElementById('send-button');

    // --- State ---
    let voices = [];
    let messages = [];
    let selectedVoice = null;
    let isLoading = false;
    let isListening = false;
    let currentStatus = "Select a voice to begin.";

    // --- Audio & Intervals ---
    let intervalRef = null;
    let audioRef = null;
    let recognitionRef = null;

    // --- Render Functions ---
    const renderVoices = () => {
        voiceSelector.innerHTML = '';
        if (voices.length === 0) {
            voiceSelector.innerHTML = '<div class="loader"></div>';
            return;
        }
        voices.forEach(voice => {
            const button = document.createElement('button');
            button.className = 'voice-button';
            button.textContent = voice.name;
            button.dataset.voiceId = voice.id;
            if (selectedVoice && selectedVoice.id === voice.id) {
                button.classList.add('selected');
            }
            button.addEventListener('click', () => startTalking(voice));
            voiceSelector.appendChild(button);
        });
    };

    const renderMessages = () => {
        messageContainer.innerHTML = '';
        const sortedMessages = [...messages].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        sortedMessages.forEach(msg => {
            const msgDiv = document.createElement('div');
            msgDiv.className = `message ${msg.role}`;
            msgDiv.textContent = msg.text;
            messageContainer.appendChild(msgDiv);
        });
        chatArea.scrollTop = chatArea.scrollHeight;
    };

    const updateStatus = (newStatus, loading) => {
        isLoading = loading;
        currentStatus = newStatus;

        statusText.textContent = currentStatus;
        statusLoader.style.display = isLoading ? 'block' : 'none';
        
        userInput.disabled = !selectedVoice || isLoading;
        sendButton.disabled = !selectedVoice || isLoading || !userInput.value.trim();
        micButton.disabled = !selectedVoice || isLoading;

        if (isListening) {
            micButton.classList.add('listening');
            micButton.textContent = '...';
        } else {
            micButton.classList.remove('listening');
            micButton.textContent = '🎤';
        }
    };
    
    userInput.addEventListener('input', () => {
       sendButton.disabled = !selectedVoice || isLoading || !userInput.value.trim();
    });

    // --- Initial Voice Setup ---
    const INITIAL_VOICES = [
        { name: 'Soothe', file: '/voice_sample_1.mp3' },
        { name: 'Whisper', file: '/voice_sample_2.mp3' },
        { name: 'Calm', file: '/voice_sample_3.mp3' },
    ];

    async function setupInitialVoices() {
        const existingVoices = room.collection('voice_v1').getList();
        if (existingVoices.length >= INITIAL_VOICES.length) {
            console.log("Voices already initialized.");
            return;
        }
        console.log("Initializing voices...");
        for (const voice of INITIAL_VOICES) {
            const existing = existingVoices.find(v => v.name === voice.name);
            if (!existing) {
                try {
                    const response = await fetch(voice.file);
                    const blob = await response.blob();
                    const file = new File([blob], voice.file.split('/').pop(), { type: blob.type });
                    const url = await websim.upload(file);
                    await room.collection('voice_v1').create({ name: voice.name, url });
                    console.log(`Created voice: ${voice.name}`);
                } catch (error) {
                    console.error(`Failed to initialize voice ${voice.name}:`, error);
                }
            }
        }
    }

    // --- Core Logic ---
    const stopTalking = () => {
        if (intervalRef) {
            clearInterval(intervalRef);
            intervalRef = null;
        }
        if (audioRef) {
            audioRef.pause();
            audioRef = null;
        }
        if (recognitionRef) {
            recognitionRef.stop();
        }
        updateStatus("Paused. Select a voice to resume.", false);
    };

    const generateAndPlayResponse = async (isUserInitiated = false) => {
        if (isLoading) return;
        updateStatus("Thinking...", true);

        const systemPrompt = `You are a gentle, soothing AI assistant. Your purpose is to talk someone to sleep.
- Your voice is very soft and calm.
- Use short, simple sentences.
- Speak slowly. Introduce pauses.
- Topics: peaceful scenery, gentle thoughts, relaxing body scans, quiet affirmations.
- If the user says something, gently acknowledge it and weave it into the peaceful narrative. Don't ask questions back. Guide the conversation back to relaxation.
- If there is no user input, continue with a calming monologue.
- Do not use markdown or emojis.`;

        const conversationHistory = messages
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
            .slice(-10)
            .map(m => ({ role: m.role, content: m.text }));

        try {
            const completion = await websim.chat.completions.create({
                messages: [
                    { role: "system", content: systemPrompt },
                    ...conversationHistory,
                ],
            });
            const textResponse = completion.content;
            
            await room.collection('message_v1').create({ role: 'ai', text: textResponse });
            
            updateStatus("Generating audio...", true);
            const ttsResult = await websim.textToSpeech({
                text: textResponse,
                voice_sample: selectedVoice.url,
            });

            audioRef = new Audio(ttsResult.url);
            audioRef.play();
            updateStatus("Speaking...", true);
            audioRef.onended = () => {
                if (intervalRef) {
                    updateStatus("Quietly waiting...", false);
                }
            };
            audioRef.onerror = () => {
                 updateStatus("Error playing audio.", false);
            }

        } catch (error) {
            console.error("Error in generation loop:", error);
            updateStatus("An error occurred. Please try again.", false);
        }
    };

    const startTalking = (voice) => {
        stopTalking();
        selectedVoice = voice;
        renderVoices(); // Re-render to show selection
        updateStatus("Starting session...", true);
        
        setTimeout(() => generateAndPlayResponse(false), 1000);

        intervalRef = setInterval(() => {
            generateAndPlayResponse(false);
        }, 15000);
    };
    
    const handleSend = async () => {
        const text = userInput.value.trim();
        if (!text || !selectedVoice || isLoading) return;
        
        userInput.value = '';
        await room.collection('message_v1').create({ role: 'user', text });
        
        if (intervalRef) clearInterval(intervalRef);
        generateAndPlayResponse(true);
        intervalRef = setInterval(() => {
            generateAndPlayResponse(false);
        }, 15000);
    };

    const handleMicClick = () => {
        if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
            alert("Speech recognition is not supported in your browser.");
            return;
        }

        if (isListening) {
            recognitionRef.stop();
            return;
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        recognitionRef = new SpeechRecognition();
        recognitionRef.continuous = false;
        recognitionRef.interimResults = false;
        recognitionRef.lang = 'en-US';

        recognitionRef.onstart = () => {
            isListening = true;
            updateStatus("Listening...", true);
        };
        
        recognitionRef.onresult = (event) => {
            const transcript = event.results[0][0].transcript;
            if (transcript.trim()) {
                room.collection('message_v1').create({ role: 'user', text: transcript }).then(() => {
                    if (intervalRef) clearInterval(intervalRef);
                    generateAndPlayResponse(true);
                    intervalRef = setInterval(() => generateAndPlayResponse(false), 15000);
                });
            }
        };

        recognitionRef.onerror = (event) => {
            console.error("Speech recognition error", event.error);
            updateStatus(`Mic error: ${event.error}`, false);
        };

        recognitionRef.onend = () => {
            isListening = false;
            if (!isLoading) {
                 updateStatus("Quietly waiting...", false);
            } else {
                 updateStatus(currentStatus, true); // Keep loading status if something else is happening
            }
        };

        recognitionRef.start();
    };

    // --- Event Listeners & Subscriptions ---
    sendButton.addEventListener('click', handleSend);
    userInput.addEventListener('keypress', (e) => e.key === 'Enter' && handleSend());
    micButton.addEventListener('click', handleMicClick);

    room.collection('voice_v1').subscribe(newVoices => {
        voices = newVoices;
        renderVoices();
    });

    room.collection('message_v1').subscribe(newMessages => {
        messages = newMessages;
        renderMessages();
    });

    // --- Initial Load ---
    setupInitialVoices();
    updateStatus(currentStatus, false);
});