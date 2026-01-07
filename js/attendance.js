// public/assets/js/attendance.js

// Helper function to format minutes to "HHh MMm"
function formatMinutesToHours(totalMinutes) {
    if (totalMinutes === null || totalMinutes < 0) return "00h 00m";
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m`;
}

// Function to populate and show the attendance report modal
function showAttendanceReportModal(recordId) {
    // attendanceRecords is expected to be available globally from the EJS context
    // This is set in the EJS template using <%- JSON.stringify(attendanceRecords) %>
    const record = window.attendanceRecords.find(r => r.id === recordId);

    if (record) {
        document.getElementById('modal-report-date').textContent = record.attendance_date;
        document.getElementById('modal-report-checkin').textContent = record.check_in_time || '-';
        document.getElementById('modal-report-checkout').textContent = record.check_out_time || '-';
        document.getElementById('modal-report-status').textContent = record.status;

        document.getElementById('modal-report-total-working').textContent = formatMinutesToHours((record.production_minutes || 0) + (record.break_minutes || 0));
        document.getElementById('modal-report-productive').textContent = formatMinutesToHours(record.production_minutes || 0);
        document.getElementById('modal-report-break').textContent = record.break_minutes + ' Min';
        document.getElementById('modal-report-overtime').textContent = record.overtime_minutes + ' Min';
        
        // If you have Bootstrap JS loaded, you can programmatically show the modal:
        // const reportModal = new bootstrap.Modal(document.getElementById('attendance_report'));
        // reportModal.show();
        // The data-bs-toggle on the table row handles showing it automatically if Bootstrap JS is linked.
    } else {
        console.error('Record not found for ID:', recordId);
    }
}

// Event listener for when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    // Attach click listeners to each table row to open the modal with specific data
    const tableRows = document.querySelectorAll('.datatable tbody tr');
    tableRows.forEach(row => {
        row.style.cursor = 'pointer'; // Indicate it's clickable
        row.addEventListener('click', () => {
            const recordId = parseInt(row.dataset.recordId); // Get ID from data-record-id attribute
            if (!isNaN(recordId)) {
                showAttendanceReportModal(recordId);
            } else {
                console.warn('Could not find record ID for row:', row);
            }
        });
    });

    // Initialize tooltips (requires Bootstrap JS)
    // Example:
    // var tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'))
    // var tooltipList = tooltipTriggerList.map(function (tooltipTriggerEl) {
    //   return new bootstrap.Tooltip(tooltipTriggerEl)
    // })
});
