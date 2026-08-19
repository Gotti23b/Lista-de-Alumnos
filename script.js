const fileInput = document.getElementById('fileInput');
const studentList = document.getElementById('studentList');
const emptyMessage = document.getElementById('emptyMessage');
const listenButton = document.getElementById('listenButton');
const status = document.getElementById('status');
const recognized = document.getElementById('recognized');

let students = [];
let recognition = null;
let listening = false;

function normalize(text) {
  return text
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function renderStudents() {
  studentList.innerHTML = '';
  emptyMessage.hidden = students.length > 0;

  students.forEach((student) => {
    const item = document.createElement('li');
    item.className = 'student';

    const name = document.createElement('span');
    name.textContent = student.name;

    const state = document.createElement('span');
    state.textContent = student.present ? 'Presente' : 'Pendiente';
    if (student.present) state.className = 'present';

    item.append(name, state);
    studentList.appendChild(item);
  });
}

function loadStudentsFromText(text) {
  const names = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(',')[0].trim())
    .filter(Boolean);

  students = names.map((name) => ({ name, present: false }));
  renderStudents();
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;

  const text = await file.text();
  loadStudentsFromText(text);
});

function markRecognizedName(spokenText) {
  const spoken = normalize(spokenText);
  if (!spoken) return;

  const match = students.find((student) => {
    const name = normalize(student.name);
    return spoken.includes(name) || name.includes(spoken);
  });

  if (match) {
    match.present = true;
    recognized.textContent = `Reconocido: ${match.name}`;
    renderStudents();
  } else {
    recognized.textContent = `No encontrado: ${spokenText}`;
  }
}

function setupRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    status.textContent = 'El reconocimiento de voz no está disponible en este navegador.';
    listenButton.disabled = true;
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'es-AR';
  recognition.continuous = true;
  recognition.interimResults = false;

  recognition.onstart = () => {
    listening = true;
    listenButton.textContent = '⏹️ Detener';
    listenButton.classList.add('listening');
    status.textContent = 'Escuchando...';
  };

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      if (event.results[i].isFinal) {
        markRecognizedName(event.results[i][0].transcript);
      }
    }
  };

  recognition.onerror = (event) => {
    status.textContent = `Error de reconocimiento: ${event.error}`;
  };

  recognition.onend = () => {
    listening = false;
    listenButton.textContent = '🎙️ Comenzar';
    listenButton.classList.remove('listening');
    status.textContent = 'Micrófono detenido.';
  };
}

listenButton.addEventListener('click', () => {
  if (!recognition) return;

  if (listening) {
    recognition.stop();
  } else {
    recognition.start();
  }
});

setupRecognition();
renderStudents();
