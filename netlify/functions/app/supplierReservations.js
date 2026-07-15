// Supplier Visit Seat Reservation - business logic. A visit is one
// supplier_reservations "header" row (visitor/company/host details)
// plus 1-2 real bookings rows (the seat-consuming legs), linked via
// bookings.supplier_reservation_id - the same shape as HOD Reserved
// Seats' bookings.source_reservation_id -> seat_reservations link
// (0023_hod_seat_assignment.sql). Every leg is created through the
// existing bookFerrySeat()/book_ferry_seat() capacity engine, unchanged -
// this file never touches capacity math directly.

import { db, unwrap } from './db.js';
import { bookFerrySeat } from './seats.js';
import { getStatusId } from './approval.js';
import { scheduleLabel, formatDate, formatTime } from './format.js';
import { createNotification } from './notifications.js';
import { sendTemplatedEmail } from './mailer.js';
import { deferBestEffort } from './deferred.js';
import { getSetting } from './settings.js';

const LEG_SELECT =
    'booking_id, schedule_id, travel_date, seats, status_id, booking_status(status_name, badge_color), ferry_schedule(service_name, departure_time, ferry_routes(direction))';

// ---------------------------------------------------------------------
// Visit purposes (admin-manageable lookup)
// ---------------------------------------------------------------------
export async function getVisitPurposes({ activeOnly = false } = {}) {
    let query = db().from('visit_purposes').select('*').order('display_order', { ascending: true });
    if (activeOnly) query = query.eq('is_active', true);
    return unwrap(await query);
}

export async function createVisitPurpose(purposeName) {
    const trimmed = (purposeName || '').trim();
    if (!trimmed) return { ok: false, reason: 'invalid_name' };
    const existing = unwrap(await db().from('visit_purposes').select('purpose_id').eq('purpose_name', trimmed).limit(1));
    if (existing.length) return { ok: false, reason: 'duplicate_name' };
    const maxOrderRows = unwrap(await db().from('visit_purposes').select('display_order').order('display_order', { ascending: false }).limit(1));
    const nextOrder = (maxOrderRows[0]?.display_order ?? 0) + 1;
    unwrap(await db().from('visit_purposes').insert({ purpose_name: trimmed, display_order: nextOrder }));
    return { ok: true };
}

export async function updateVisitPurpose(purposeId, purposeName) {
    const trimmed = (purposeName || '').trim();
    if (!trimmed) return { ok: false, reason: 'invalid_name' };
    unwrap(await db().from('visit_purposes').update({ purpose_name: trimmed }).eq('purpose_id', purposeId));
    return { ok: true };
}

export async function setVisitPurposeActive(purposeId, isActive) {
    unwrap(await db().from('visit_purposes').update({ is_active: isActive }).eq('purpose_id', purposeId));
    return { ok: true };
}

// ---------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------
async function logSupplierAction({ reservationId, bookingId, supplierCompany, visitorName, hostEmployeeName, ferryService, seats, statusName, action, performedByUserId }) {
    unwrap(
        await db()
            .from('supplier_reservation_log')
            .insert({
                reservation_id: reservationId,
                booking_id: bookingId ?? null,
                supplier_company_snapshot: supplierCompany,
                visitor_name_snapshot: visitorName,
                host_employee_snapshot: hostEmployeeName,
                ferry_service_snapshot: ferryService ?? null,
                seats: seats ?? null,
                status_snapshot: statusName ?? null,
                action,
                performed_by_user_id: performedByUserId,
            })
    );
}

// ---------------------------------------------------------------------
// Notifications - createNotification() (in-app) + a deferred templated
// email, mirroring notifySecurityIfWaitingList()/HR Manual Booking's
// existing pattern. Recipients are looked up by role name, matching
// getActiveSecurityUsers()'s own established, cheap convention rather
// than computing full effective-permission bitmasks per user.
// ---------------------------------------------------------------------
const SUPPLIER_MANAGER_ROLES = ['Administrator', 'Cluster General Manager', 'Resident Manager', 'Cluster Director of HR', 'Assistant HR Manager'];

async function getActiveUsersByRoleNames(roleNames) {
    return unwrap(
        await db()
            .from('users')
            .select('user_id, full_name, email, roles!inner(role_name)')
            .eq('status', 'active')
            .in('roles.role_name', roleNames)
    );
}

async function notifySupplierReservationCreated(reservation, legs) {
    if ((await getSetting('notifications_enabled', '1')) !== '1') return;

    const hostRows = unwrap(await db().from('users').select('user_id, full_name, email').eq('user_id', reservation.host_employee_user_id).limit(1));
    const host = hostRows[0];
    const [managers, security] = await Promise.all([getActiveUsersByRoleNames(SUPPLIER_MANAGER_ROLES), getActiveUsersByRoleNames(['Security'])]);

    const recipients = new Map();
    if (host) recipients.set(host.user_id, host);
    for (const m of managers) recipients.set(m.user_id, m);
    for (const s of security) recipients.set(s.user_id, s);

    const firstLeg = legs[0];
    const message = `Supplier visit reservation: ${reservation.visitor_name} (${reservation.supplier_company}) - ${formatDate(firstLeg.travel_date)} ${formatTime(firstLeg.ferry_schedule.departure_time)}.`;

    for (const recipient of recipients.values()) {
        await createNotification(recipient.user_id, message, 'booking', firstLeg.booking_id);
        if (recipient.email) {
            deferBestEffort(
                sendTemplatedEmail(
                    'supplier_reservation_notice',
                    recipient.email,
                    {
                        recipient_name: recipient.full_name,
                        visitor_name: reservation.visitor_name,
                        supplier_company: reservation.supplier_company,
                        host_employee_name: host?.full_name ?? '',
                        ferry_service: scheduleLabel(firstLeg.ferry_schedule),
                        travel_date: formatDate(firstLeg.travel_date),
                        booking_reference: `BK-${firstLeg.booking_id}`,
                    },
                    { relatedBookingId: firstLeg.booking_id }
                ),
                'sendTemplatedEmail:supplier_reservation_notice'
            );
        }
    }
}

// ---------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------
export async function createSupplierReservation({
    supplierCompany,
    visitorName,
    nationality,
    contactNumber,
    email,
    pax,
    visitPurposeId,
    visitingDepartmentId,
    hostEmployeeUserId,
    hostDepartmentId,
    resortId,
    boardingLocation,
    destination,
    travelDate,
    scheduleId,
    returnRequired,
    returnScheduleId,
    remarks,
    createdByUserId,
}) {
    const purposeRows = visitPurposeId ? unwrap(await db().from('visit_purposes').select('purpose_name').eq('purpose_id', visitPurposeId).limit(1)) : [];
    const purposeLabel = purposeRows[0]?.purpose_name || 'Supplier Visit';

    const reservationRows = unwrap(
        await db()
            .from('supplier_reservations')
            .insert({
                supplier_company: supplierCompany,
                visitor_name: visitorName,
                nationality: nationality || null,
                contact_number: contactNumber,
                email: email || null,
                pax,
                visit_purpose_id: visitPurposeId || null,
                visiting_department_id: visitingDepartmentId || null,
                host_employee_user_id: hostEmployeeUserId,
                host_department_id: hostDepartmentId || null,
                resort_id: resortId || null,
                boarding_location: boardingLocation || null,
                destination: destination || null,
                return_required: !!returnRequired,
                remarks: remarks || null,
                created_by_user_id: createdByUserId,
            })
            .select('*')
    );
    const reservation = reservationRows[0];

    async function createLeg(legScheduleId) {
        const booking = await bookFerrySeat({
            userId: hostEmployeeUserId,
            scheduleId: legScheduleId,
            travelDate,
            direction: boardingLocation && destination ? `${boardingLocation} to ${destination}` : purposeLabel,
            purpose: purposeLabel,
            remarks: remarks || null,
            seats: pax,
        });
        unwrap(
            await db()
                .from('bookings')
                .update({ supplier_reservation_id: reservation.reservation_id, booking_method: 'supplier' })
                .eq('booking_id', booking.booking_id)
        );
        return booking;
    }

    const outboundBooking = await createLeg(scheduleId);
    const legBookingIds = [outboundBooking.booking_id];
    if (returnRequired && returnScheduleId) {
        const returnBooking = await createLeg(returnScheduleId);
        legBookingIds.push(returnBooking.booking_id);
    }

    const legs = unwrap(await db().from('bookings').select(LEG_SELECT).in('booking_id', legBookingIds));
    const hostRows = unwrap(await db().from('users').select('full_name').eq('user_id', hostEmployeeUserId).limit(1));
    const hostName = hostRows[0]?.full_name ?? '';

    for (const leg of legs) {
        await logSupplierAction({
            reservationId: reservation.reservation_id,
            bookingId: leg.booking_id,
            supplierCompany,
            visitorName,
            hostEmployeeName: hostName,
            ferryService: scheduleLabel(leg.ferry_schedule),
            seats: leg.seats,
            statusName: leg.booking_status.status_name,
            action: 'created',
            performedByUserId: createdByUserId,
        });
    }

    await notifySupplierReservationCreated(reservation, legs);

    return { reservation, legs };
}

// ---------------------------------------------------------------------
// Status transitions - Pending/Approved/Confirmed/Cancelled only.
// Checked-In/Departed/Arrived stay exclusively Security's domain via
// the unchanged recordMovement() in security.js.
// ---------------------------------------------------------------------
const MANAGED_LEG_STATUSES = ['Pending', 'Approved', 'Confirmed', 'Cancelled'];

export async function setLegStatus(bookingId, newStatusName, performedByUserId) {
    if (!MANAGED_LEG_STATUSES.includes(newStatusName)) return { ok: false, reason: 'invalid_status' };
    const rows = unwrap(
        await db()
            .from('bookings')
            .select('booking_id, supplier_reservation_id, seats, ferry_schedule(service_name, departure_time, ferry_routes(direction)), supplier_reservations(supplier_company, visitor_name, host_employee_user_id)')
            .eq('booking_id', bookingId)
            .limit(1)
    );
    const booking = rows[0];
    if (!booking || !booking.supplier_reservation_id) return { ok: false, reason: 'not_found' };

    const statusId = await getStatusId(newStatusName);
    unwrap(await db().from('bookings').update({ status_id: statusId }).eq('booking_id', bookingId));

    const hostRows = unwrap(await db().from('users').select('full_name').eq('user_id', booking.supplier_reservations.host_employee_user_id).limit(1));
    await logSupplierAction({
        reservationId: booking.supplier_reservation_id,
        bookingId,
        supplierCompany: booking.supplier_reservations.supplier_company,
        visitorName: booking.supplier_reservations.visitor_name,
        hostEmployeeName: hostRows[0]?.full_name ?? '',
        ferryService: scheduleLabel(booking.ferry_schedule),
        seats: booking.seats,
        statusName: newStatusName,
        action: 'status_changed',
        performedByUserId,
    });
    return { ok: true };
}

export async function cancelSupplierReservation(reservationId, performedByUserId) {
    const legs = unwrap(
        await db()
            .from('bookings')
            .select('booking_id, seats, ferry_schedule(service_name, departure_time, ferry_routes(direction)), booking_status(status_name)')
            .eq('supplier_reservation_id', reservationId)
    );
    const cancelledId = await getStatusId('Cancelled');
    const reservationRows = unwrap(await db().from('supplier_reservations').select('supplier_company, visitor_name, host_employee_user_id').eq('reservation_id', reservationId).limit(1));
    const reservation = reservationRows[0];
    if (!reservation) return { ok: false, reason: 'not_found' };
    const hostRows = unwrap(await db().from('users').select('full_name').eq('user_id', reservation.host_employee_user_id).limit(1));

    for (const leg of legs) {
        if (['Cancelled', 'Rejected', 'Expired'].includes(leg.booking_status.status_name)) continue;
        unwrap(await db().from('bookings').update({ status_id: cancelledId }).eq('booking_id', leg.booking_id));
        await logSupplierAction({
            reservationId,
            bookingId: leg.booking_id,
            supplierCompany: reservation.supplier_company,
            visitorName: reservation.visitor_name,
            hostEmployeeName: hostRows[0]?.full_name ?? '',
            ferryService: scheduleLabel(leg.ferry_schedule),
            seats: leg.seats,
            statusName: 'Cancelled',
            action: 'cancelled',
            performedByUserId,
        });
    }
    return { ok: true };
}

// ---------------------------------------------------------------------
// List / search
// ---------------------------------------------------------------------
export async function getSupplierReservations({ dateFrom, dateTo, search } = {}) {
    let query = db()
        .from('supplier_reservations')
        .select(
            'reservation_id, supplier_company, visitor_name, nationality, contact_number, email, pax, return_required, remarks, created_at, ' +
                'visit_purposes(purpose_name), visiting_department:departments!supplier_reservations_visiting_department_id_fkey(department_name), ' +
                'host_department:departments!supplier_reservations_host_department_id_fkey(department_name), ' +
                'users!supplier_reservations_host_employee_user_id_fkey(full_name, employee_id), resorts(resort_name), ' +
                `bookings(${LEG_SELECT})`
        )
        .order('created_at', { ascending: false })
        .limit(300);
    const rows = unwrap(await query);

    let results = rows;
    if (dateFrom) results = results.filter((r) => r.bookings.some((b) => b.travel_date >= dateFrom));
    if (dateTo) results = results.filter((r) => r.bookings.some((b) => b.travel_date <= dateTo));
    if (search) {
        const needle = search.toLowerCase();
        results = results.filter(
            (r) =>
                r.supplier_company.toLowerCase().includes(needle) ||
                r.visitor_name.toLowerCase().includes(needle) ||
                (r.users?.full_name ?? '').toLowerCase().includes(needle) ||
                (r.host_department?.department_name ?? '').toLowerCase().includes(needle) ||
                (r.visiting_department?.department_name ?? '').toLowerCase().includes(needle) ||
                r.bookings.some((b) => scheduleLabel(b.ferry_schedule).toLowerCase().includes(needle)) ||
                r.bookings.some((b) => b.travel_date.includes(needle))
        );
    }
    return results;
}

// ---------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------
export async function getSupplierDashboardStats() {
    const today = new Date().toISOString().slice(0, 10);
    const rows = unwrap(await db().from('bookings').select('travel_date, booking_status(status_name)').eq('booking_method', 'supplier'));

    let today_count = 0;
    let upcoming = 0;
    let checkedIn = 0;
    let departed = 0;
    let arrived = 0;
    let cancelled = 0;
    for (const r of rows) {
        const statusName = r.booking_status.status_name;
        if (r.travel_date === today) today_count++;
        if (r.travel_date > today) upcoming++;
        if (statusName === 'Checked-In') checkedIn++;
        if (statusName === 'Departed') departed++;
        if (statusName === 'Arrived') arrived++;
        if (statusName === 'Cancelled') cancelled++;
    }
    return { today: today_count, upcoming, checkedIn, departed, arrived, cancelled };
}
