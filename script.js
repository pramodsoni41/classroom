// ==========================
// CONFIG
// ==========================
const API_URL = "https://script.google.com/macros/s/AKfycbxw1m9FyxuAnDziakgPTvXqo9RT0P4bq8g_c-RN3rgDnstqIe0r-_fI6fg8mwU9w-7W/exec";

let dashboardData = null;
let selectedCourse = null;


// ==========================
// HELPERS
// ==========================
function $(id) {
  return document.getElementById(id);
}

function setMessage(el, text, color = "red") {
  if (!el) return;
  el.innerText = text;
  el.style.color = color;
}

function redirect(page) {
  window.location.href = page;
}


// ==========================
// LOGIN (CLASSROOM ONLY)
// ==========================
async function login() {

  const roll = $("roll").value.trim();
  const password = $("password").value.trim();
  const msg = $("loginMessage");

  if (!roll || !password) {
    return setMessage(msg, "Enter roll and password.");
  }

  setMessage(msg, "Checking...", "#555");

  try {

    const url = `${API_URL}?action=login&roll=${encodeURIComponent(roll)}&password=${encodeURIComponent(password)}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "success") {
      return setMessage(msg, data.message || "Invalid login.");
    }

    // Save session
    localStorage.setItem("student_roll", data.student.RollNo);
    localStorage.setItem("student_name", data.student.Name);
    localStorage.setItem("student_phone", data.student.Phone || "");
localStorage.setItem("student_pass", password);   // ✅ ADD THIS
    redirect("dashboard.html");

  } catch (err) {
    setMessage(msg, "Server error. Try again.");
  }
}


// ==========================
// LOAD DASHBOARD
// ==========================
async function loadDashboard() {

  if (!window.location.pathname.includes("dashboard.html")) return;

  const roll = localStorage.getItem("student_roll");

  if (!roll) {
    return redirect("index.html");
  }

  try {

    const url = `${API_URL}?action=dashboard&roll=${encodeURIComponent(roll)}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "success") {
      alert(data.message);
      return logout();
    }

    dashboardData = data;

    renderStudent(data.student);
    renderCourses(data.student.Courses);

    if (data.student.Courses?.length) {
      selectCourse(data.student.Courses[0]);
    }

  } catch {
    document.body.innerHTML = "<h3 style='padding:20px;'>Unable to load dashboard.</h3>";
  }
}


// ==========================
// RENDER STUDENT
// ==========================
function renderStudent(student) {
  $("studentInfo").innerText = `${student.Name} | ${student.RollNo}`;
}


// ==========================
// COURSES
// ==========================
function renderCourses(courses) {

  const box = $("courseTabs");

  if (!courses || courses.length === 0) {
    box.innerHTML = "<p>No courses found.</p>";
    return;
  }

  box.innerHTML = courses.map(c =>
    `<button class="course-btn" onclick="selectCourse('${c}')">${c}</button>`
  ).join("");
}


// ==========================
// SELECT COURSE
// ==========================
function selectCourse(course) {

  selectedCourse = course;

  $("selectedCourseTitle").innerText = `${course} Dashboard`;

  document.querySelectorAll(".course-btn").forEach(btn => {
    btn.classList.toggle("active-course", btn.innerText === course);
  });

  const marks = filterByCourse(dashboardData.marks, course);
  const attendance = filterByCourse(dashboardData.attendance, course);
  const notes = filterByCourse(dashboardData.notes, course);
  const announcements = dashboardData.announcements.filter(a =>
    !a.Course || String(a.Course).trim() === course
  );

  renderMarks(marks);
  renderAttendance(attendance);
  renderNotes(notes);
  renderAnnouncements(announcements);
}


// ==========================
// FILTER
// ==========================
function filterByCourse(data, course) {
  if (!data) return [];
  return data.filter(row => String(row.Course).trim() === course);
}


// ==========================
// MARKS
// ==========================
function renderMarks(list) {

  const box = $("marks");

  if (!list.length) {
    return box.innerHTML = "<p>No marks uploaded.</p>";
  }

  const m = list[0];

  box.innerHTML = `
    <table>
      <tr><td>Quiz1</td><td>${m.Quiz1 || "-"}</td></tr>
      <tr><td>Quiz2</td><td>${m.Quiz2 || "-"}</td></tr>
      <tr><td>MidSem</td><td>${m.MidSem || "-"}</td></tr>
      <tr><td>EndSem</td><td>${m.EndSem || "-"}</td></tr>
      <tr><td>Total</td><td>${m.Total || "-"}</td></tr>
    </table>
  `;
}


// ==========================
// ATTENDANCE
// ==========================
function renderAttendance(list) {

  const box = $("attendance");

  if (!list.length) {
    return box.innerHTML = "<p>No attendance uploaded.</p>";
  }

  let html = "";

  list.forEach(a => {

    html += "<table>";

    Object.keys(a).forEach(key => {
      if (key !== "RollNo" && key !== "Course") {
        html += `<tr><td>${key}</td><td>${a[key]}</td></tr>`;
      }
    });

    html += "</table>";
  });

  box.innerHTML = html;
}


// ==========================
// NOTES
// ==========================
function renderNotes(list) {

  const box = $("notes");

  if (!list.length) {
    return box.innerHTML = "<p>No notes uploaded.</p>";
  }

  box.innerHTML = list.map(n => `
    <div class="card">
      <h4>${n.Title}</h4>
      <p>${n.Description || ""}</p>
      <p class="date">${n.Date || ""}</p>
      <a href="${n.Link}" target="_blank">Open Notes</a>
    </div>
  `).join("");
}


// ==========================
// ANNOUNCEMENTS
// ==========================
function renderAnnouncements(list) {

  const box = $("announcements");

  if (!list.length) {
    return box.innerHTML = "<p>No announcements.</p>";
  }

  box.innerHTML = list.map(a => `
    <div class="card">
      <h4>${a.Title}</h4>
      <p>${a.Message}</p>
      <p class="date">${a.Date || ""}</p>
    </div>
  `).join("");
}
// ==========================
// QUIZ BUTTON (WORKING VERSION)
// ==========================
async function goToQuiz() {

  const roll = localStorage.getItem("student_roll");
  const name = localStorage.getItem("student_name");
  const password = localStorage.getItem("student_pass");
  const phone = localStorage.getItem("student_phone");



  // Open new tab directly (no popup)
  const newTab = window.open("", "_blank");

  const quizURL =
    `https://pramodsoni.in/Quiz/?roll=${encodeURIComponent(roll)}`
    + `&password=${encodeURIComponent(password)}`
    + `&name=${encodeURIComponent(name || "")}`
    + `&phone=${encodeURIComponent(phone || "")}`;

  newTab.location.href = quizURL;
}

// ==========================
// CHANGE PASSWORD
// ==========================
async function changePassword() {

  const roll = localStorage.getItem("student_roll");

  const oldPass = $("oldPass").value.trim();
  const newPass = $("newPass").value.trim();
  const confirmPass = $("confirmPass").value.trim();

  const msg = $("passMsg");

  if (!oldPass || !newPass || !confirmPass) {
    return setMessage(msg, "Fill all fields.");
  }

  if (newPass !== confirmPass) {
    return setMessage(msg, "Passwords do not match.");
  }

  try {

    const url = `${API_URL}?action=changePassword`
      + `&roll=${encodeURIComponent(roll)}`
      + `&oldPassword=${encodeURIComponent(oldPass)}`
      + `&newPassword=${encodeURIComponent(newPass)}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "success") {
      return setMessage(msg, data.message);
    }

    setMessage(msg, "Password updated. Login again.", "green");

    setTimeout(() => {
      logout();
    }, 1500);

  } catch {
    setMessage(msg, "Error updating password.");
  }
}


// ==========================
// LOGOUT
// ==========================
function logout() {
  localStorage.clear();
  redirect("index.html");
}


// ==========================
// INIT
// ==========================
loadDashboard();