const API_URL = "https://script.google.com/macros/s/AKfycbwHXMjnCx7YGP9Wbv1jyrdxrVs-zAXc53WD9oGylgAvlbEf-zUJRrO3kQhSbFE9Z8a1/exec";

async function login() {
  const roll = document.getElementById("roll").value.trim();
  const password = document.getElementById("password").value.trim();
  const msg = document.getElementById("loginMessage");

  if (!roll || !password) {
    msg.innerText = "Please enter roll number and password.";
    msg.style.color = "red";
    return;
  }

  msg.innerText = "Checking login...";
  msg.style.color = "#555";

  try {
    const url = `${API_URL}?action=login&roll=${encodeURIComponent(roll)}&password=${encodeURIComponent(password)}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status === "success") {
      localStorage.setItem("student_roll", roll);
      localStorage.setItem("student_name", data.student.Name);
      window.location.href = "dashboard.html";
    } else {
      msg.innerText = data.message;
      msg.style.color = "red";
    }
  } catch (error) {
    msg.innerText = "Unable to connect to server.";
    msg.style.color = "red";
  }
}

async function loadDashboard() {
  if (!window.location.pathname.includes("dashboard.html")) {
    return;
  }

  const roll = localStorage.getItem("student_roll");

  if (!roll) {
    window.location.href = "index.html";
    return;
  }

  try {
    const url = `${API_URL}?action=dashboard&roll=${encodeURIComponent(roll)}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "success") {
      alert(data.message);
      logout();
      return;
    }

    renderStudent(data.student);
    renderMarks(data.marks);
    renderAttendance(data.attendance);
    renderNotes(data.notes);
    renderAnnouncements(data.announcements);

  } catch (error) {
    document.body.innerHTML = "<h3 style='padding:20px;'>Unable to load dashboard.</h3>";
  }
}

function renderStudent(student) {
  document.getElementById("studentInfo").innerText =
    `${student.Name} | ${student.RollNo} | ${student.Course}`;
}

function renderMarks(marks) {
  let html = "<table>";

  for (let key in marks) {
    if (key !== "RollNo") {
      html += `
        <tr>
          <td>${key}</td>
          <td>${marks[key]}</td>
        </tr>
      `;
    }
  }

  html += "</table>";
  document.getElementById("marks").innerHTML = html;
}

function renderAttendance(attendance) {
  document.getElementById("attendance").innerHTML = `
    <p><b>Total Classes:</b> ${attendance.TotalClasses || "-"}</p>
    <p><b>Present:</b> ${attendance.Present || "-"}</p>
    <p><b>Attendance:</b> ${attendance.Percentage || "-"}%</p>
  `;
}

function renderNotes(notes) {
  const box = document.getElementById("notes");

  if (!notes || notes.length === 0) {
    box.innerHTML = "<p>No notes uploaded.</p>";
    return;
  }

  box.innerHTML = notes.map(note => `
    <div class="card">
      <h4>${note.Title}</h4>
      <p>${note.Description || ""}</p>
      <p class="date">${note.Date || ""}</p>
      <a href="${note.Link}" target="_blank">Open Notes</a>
    </div>
  `).join("");
}

function renderAnnouncements(announcements) {
  const box = document.getElementById("announcements");

  if (!announcements || announcements.length === 0) {
    box.innerHTML = "<p>No announcements.</p>";
    return;
  }

  box.innerHTML = announcements.map(item => `
    <div class="card">
      <h4>${item.Title}</h4>
      <p>${item.Message}</p>
      <p class="date">${item.Date || ""}</p>
    </div>
  `).join("");
}

function logout() {
  localStorage.removeItem("student_roll");
  localStorage.removeItem("student_name");
  window.location.href = "index.html";
}

loadDashboard();