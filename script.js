const API_URL = "https://script.google.com/macros/s/AKfycbxXHIW8rSuwDXTjN_E4S8tDkdzp7o2MSeum49Yu3B7BKSj5HxSf5c--SUSV6ep_VdNN/exec";

let dashboardData = null;
let selectedCourse = null;

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

    dashboardData = data;

    renderStudent(data.student);
    renderCourseTabs(data.student.Courses);

    if (data.student.Courses.length > 0) {
      selectCourse(data.student.Courses[0]);
    } else {
      document.getElementById("courseTabs").innerHTML = "<p>No registered course found.</p>";
    }

  } catch (error) {
    document.body.innerHTML = "<h3 style='padding:20px;'>Unable to load dashboard.</h3>";
  }
}

function renderStudent(student) {
  document.getElementById("studentInfo").innerText =
    `${student.Name} | ${student.RollNo}`;
}

function renderCourseTabs(courses) {
  const box = document.getElementById("courseTabs");

  box.innerHTML = courses.map(course => `
    <button class="course-btn" onclick="selectCourse('${course}')">${course}</button>
  `).join("");
}

function selectCourse(course) {
  selectedCourse = course;

  document.getElementById("selectedCourseTitle").innerText = `${course} Dashboard`;

  document.querySelectorAll(".course-btn").forEach(btn => {
    btn.classList.remove("active-course");
    if (btn.innerText === course) {
      btn.classList.add("active-course");
    }
  });

  const marks = dashboardData.marks.filter(row =>
    String(row.Course).trim() === course
  );

  const attendance = dashboardData.attendance.filter(row =>
    String(row.Course).trim() === course
  );

  const notes = dashboardData.notes.filter(row =>
    String(row.Course).trim() === course
  );

  const announcements = dashboardData.announcements.filter(row =>
    !row.Course || String(row.Course).trim() === course
  );

  renderMarks(marks);
  renderAttendance(attendance);
  renderNotes(notes);
  renderAnnouncements(announcements);
}

function renderMarks(marksList) {
  const box = document.getElementById("marks");

  if (!marksList || marksList.length === 0) {
    box.innerHTML = "<p>No marks uploaded for this course.</p>";
    return;
  }

  let html = "";

  marksList.forEach(marks => {
    html += "<table>";

    for (let key in marks) {
      if (key !== "RollNo" && key !== "Course") {
        html += `
          <tr>
            <td>${key}</td>
            <td>${marks[key]}</td>
          </tr>
        `;
      }
    }

    html += "</table>";
  });

  box.innerHTML = html;
}

function renderAttendance(attendanceList) {
  const box = document.getElementById("attendance");

  if (!attendanceList || attendanceList.length === 0) {
    box.innerHTML = "<p>No attendance uploaded for this course.</p>";
    return;
  }

  let html = "";

  attendanceList.forEach(attendance => {
    html += "<table>";

    for (let key in attendance) {
      if (key !== "RollNo" && key !== "Course") {
        html += `
          <tr>
            <td>${key}</td>
            <td>${attendance[key]}</td>
          </tr>
        `;
      }
    }

    html += "</table>";
  });

  box.innerHTML = html;
}

function renderNotes(notes) {
  const box = document.getElementById("notes");

  if (!notes || notes.length === 0) {
    box.innerHTML = "<p>No notes uploaded for this course.</p>";
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
    box.innerHTML = "<p>No announcements for this course.</p>";
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

async function changePassword() {

  const roll = localStorage.getItem("student_roll");

  const oldPass = document.getElementById("oldPass").value.trim();
  const newPass = document.getElementById("newPass").value.trim();
  const confirmPass = document.getElementById("confirmPass").value.trim();

  const msg = document.getElementById("passMsg");

  if (!oldPass || !newPass || !confirmPass) {
    msg.innerText = "Please fill all fields.";
    msg.style.color = "red";
    return;
  }

  if (newPass !== confirmPass) {
    msg.innerText = "Passwords do not match.";
    msg.style.color = "red";
    return;
  }

  if (newPass.length < 4) {
    msg.innerText = "Password must be at least 4 characters.";
    msg.style.color = "red";
    return;
  }

  msg.innerText = "Updating password...";
  msg.style.color = "#555";

  try {

    const url =
      `${API_URL}?action=changePassword` +
      `&roll=${encodeURIComponent(roll)}` +
      `&oldPassword=${encodeURIComponent(oldPass)}` +
      `&newPassword=${encodeURIComponent(newPass)}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.status === "success") {

      msg.innerText = "Password updated. Please login again.";
      msg.style.color = "green";

      // 🔴 IMPORTANT: FORCE LOGOUT AFTER 2 SECONDS
      setTimeout(() => {
        logout();
      }, 2000);

    } else {
      msg.innerText = data.message;
      msg.style.color = "red";
    }

  } catch (error) {
    msg.innerText = "Error updating password.";
    msg.style.color = "red";
  }
}

function logout() {
  localStorage.removeItem("student_roll");
  localStorage.removeItem("student_name");
  window.location.href = "index.html";
}

loadDashboard();