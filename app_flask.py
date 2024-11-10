from flask import Flask, request, jsonify, render_template
from gtts import gTTS
from io import BytesIO
import base64
from googletrans import Translator  # Libreria di traduzione

app = Flask(__name__)
translator = Translator()

@app.route('/')
def home():
    # Ritorna il file HTML per l'interfaccia utente
    return render_template('index.html')

@app.route('/process_audio', methods=['POST'])
def process_audio():
    try:
        # Ricevi i dati JSON dal frontend
        data = request.json
        if not data or 'text' not in data:
            return jsonify({'error': 'Richiesta non valida. Il campo "text" è mancante.'}), 400

        # Testo ricevuto
        input_text = data['text']
        print(f"Testo ricevuto: {input_text}")

        # Traduci il testo in inglese (puoi cambiare la lingua di destinazione)
        translated = translator.translate(input_text, src='it', dest='en')
        translated_text = translated.text
        print(f"Testo tradotto: {translated_text}")

        # Genera l'audio della traduzione
        tts = gTTS(translated_text, lang='en')
        audio_fp = BytesIO()
        tts.write_to_fp(audio_fp)
        audio_fp.seek(0)

        # Converti l'audio in base64
        audio_base64 = base64.b64encode(audio_fp.read()).decode('utf-8')
        print("Audio generato con successo.")

        return jsonify({'text': translated_text, 'audio': audio_base64})

    except Exception as e:
        print(f"Errore nel backend: {str(e)}")
        return jsonify({'error': str(e)}), 500

if __name__ == "__main__":
    app.run(debug=True)
