// Seed data for the Cityscape Books prototype. Project CSD-PRJ-0001 is transcribed from the Hire Nexa payment sheet.
window.CSD_DATA = (function () {
  const company = {
    name: 'Cityscape Decors', tagline: 'Interiors & Construction',
    address: '[Registered office address], Chennai – 600 000, Tamil Nadu',
    gstin: '33XXXXX0000X1ZX', state: 'Tamil Nadu', stateCode: '33',
    phone: '+91 [phone]', email: 'accounts@cityscapedecors.in',
    bank: { name: '[Bank name]', acc: '[Account number]', ifsc: '[IFSC]', branch: '[Branch]' },
    lockDate: '2026-09-30'
  };
  const users = [
    { id: 'u1', name: 'Saravanan S', first: 'Saravanan', role: 'owner', roleLabel: 'Owner', email: 'saravanan@cityscapedecors.in', phone: '+91 98•••••210', projects: 'All', last: '14 Oct 2026, 09:02' },
    { id: 'u2', name: 'Accounts Admin', first: 'Admin', role: 'admin', roleLabel: 'Admin · Accounts', email: 'accounts@cityscapedecors.in', phone: '+91 97•••••118', projects: 'All', last: '14 Oct 2026, 09:40' },
    { id: 'u3', name: 'Shiva', first: 'Shiva', role: 'manager', roleLabel: 'Project Manager', email: 'shiva@cityscapedecors.in', phone: '+91 94•••••562', projects: 'All', last: '13 Oct 2026, 19:15' },
    { id: 'u4', name: 'Site Engineer', first: 'Site Engineer', role: 'site', roleLabel: 'Site Engineer', email: 'site@cityscapedecors.in', phone: '+91 90•••••347', projects: ['P1', 'P5'], last: '13 Oct 2026, 18:42' },
    { id: 'u5', name: 'Asst. Manager', first: 'Asst. Manager', role: 'asstmgr', roleLabel: 'Asst. Manager · Project Management', email: 'asstpm@cityscapedecors.in', phone: '+91 93•••••784', projects: 'All', last: '12 Oct 2026, 6:05 pm' }
  ];
  const clients = [
    { id: 'C1', name: 'Hire Nexa Pvt Ltd', contact: 'Ramesh', gstin: '33AAHCH2210K1Z4', state: 'Tamil Nadu', stateCode: '33', address: 'Medavakkam, Chennai – 600 100' },
    { id: 'C2', name: 'Anand Kumar', contact: 'Anand Kumar', gstin: '', state: 'Tamil Nadu', stateCode: '33', address: 'Anna Nagar West, Chennai – 600 040' },
    { id: 'C3', name: 'Vertex Labs LLP', contact: 'Nikhil Rao', gstin: '29AAKFV7731M1Z2', state: 'Karnataka', stateCode: '29', address: 'Whitefield, Bengaluru – 560 066' },
    { id: 'C4', name: 'Dr. Meenakshi R', contact: 'Dr. Meenakshi R', gstin: '', state: 'Tamil Nadu', stateCode: '33', address: 'Kovilambakkam, Chennai – 600 129' },
    { id: 'C5', name: 'Sri Balaji Jewellers', contact: 'Venkatesh B', gstin: '33ABGFS4412Q1Z9', state: 'Tamil Nadu', stateCode: '33', address: 'Usman Road, T. Nagar, Chennai – 600 017' }
  ];
  const projects = [
    { id: 'P1', code: 'CSD-PRJ-0001', name: 'Hire Nexa Office Interiors', clientId: 'C1', site: 'Medavakkam, Chennai', status: 'Active', start: '2026-09-09', contract: 1000000, budget: 750000, engineer: 'u4', manager: 'u3' },
    { id: 'P2', code: 'CSD-PRJ-0002', name: 'Anand Residence – 3BHK Interiors', clientId: 'C2', site: 'Anna Nagar, Chennai', status: 'Active', start: '2026-08-01', contract: 1450000, budget: 1080000, engineer: 'u3', manager: 'u3' },
    { id: 'P3', code: 'CSD-PRJ-0003', name: 'Vertex Labs Office Fit-out', clientId: 'C3', site: 'Whitefield, Bengaluru', status: 'Active', start: '2026-07-15', contract: 2200000, budget: 1650000, engineer: 'u3', manager: 'u3' },
    { id: 'P4', code: 'CSD-PRJ-0004', name: 'Meenakshi Clinic Renovation', clientId: 'C4', site: 'Kovilambakkam, Chennai', status: 'Completed', start: '2026-06-02', contract: 620000, budget: 440000, engineer: 'u3', manager: 'u3' },
    { id: 'P5', code: 'CSD-PRJ-0005', name: 'Sri Balaji Showroom Facade', clientId: 'C5', site: 'T. Nagar, Chennai', status: 'Active', start: '2026-10-01', contract: 840000, budget: 600000, engineer: 'u4', manager: 'u3' }
  ];
  const L = (desc, rate, qty, unit) => ({ desc, sac: '9954', qty: qty || 1, unit: unit || 'Lot', rate });
  const invoices = [
    { id: 'I1', no: 'CSD/26-27/0001', pid: 'P4', date: '2026-06-02', due: '2026-06-17', items: [L('Civil works & vitrified tiling', 210000), L('Reception counter & storage cabinets', 190000), L('Painting & finishing', 120000), L('Electrical & lighting', 100000)] },
    { id: 'I2', no: 'CSD/26-27/0002', pid: 'P3', date: '2026-07-12', due: '2026-07-27', items: [L('Aluminium & glass office partitions', 680000), L('Workstations – 48 seats', 15000, 48, 'Seat'), L('Conference room & cabins', 410000), L('False ceiling & lighting', 260000), L('Vinyl flooring', 130000)] },
    { id: 'I3', no: 'CSD/26-27/0003', pid: 'P2', date: '2026-07-28', due: '2026-08-12', items: [L('Modular kitchen', 420000), L('Wardrobes', 120000, 3, 'Nos'), L('False ceiling & lighting', 240000), L('TV unit & wall paneling', 210000), L('Painting & polishing', 130000), L('Loose furniture', 90000)] },
    { id: 'I4', no: 'CSD/26-27/0004', pid: 'P1', date: '2026-09-08', due: '2026-09-23', items: [L('Gypsum partitions & false ceiling', 320000), L('Workstations & carpentry', 380000), L('Toughened glass partitions', 140000), L('Painting & finishing', 110000), L('Electrical & lighting', 50000)] },
    { id: 'I5', no: 'CSD/26-27/0005', pid: 'P5', date: '2026-09-29', due: '2026-10-14', items: [L('ACP facade cladding', 520000), L('Signage & facade lighting', 180000), L('Entrance glass & doors', 140000)] }
  ];
  const receipts = [
    ['P4', '2026-06-05', 300000, 'Bank', 'NEFT HDFCN26156021', 'Admin'],
    ['P4', '2026-07-10', 250000, 'Bank', 'NEFT SBIN26191440', 'Admin'],
    ['P4', '2026-08-14', 100000, 'Cheque', 'Chq 004517 · IOB', 'Admin'],
    ['P3', '2026-07-14', 1000000, 'Bank', 'RTGS ICIC26195K11', 'Admin'],
    ['P3', '2026-08-20', 800000, 'Bank', 'RTGS ICIC26232K73', 'Admin'],
    ['P2', '2026-07-30', 400000, 'Bank', 'NEFT KKBK26211050', 'Admin'],
    ['P2', '2026-08-28', 350000, 'Cheque', 'Chq 118204 · Axis', 'Shiva'],
    ['P1', '2026-09-09', 300000, 'Bank', 'NEFT UTIB26252090', 'Saravanan'],
    ['P1', '2026-09-21', 200000, 'Bank', 'NEFT UTIB26264181', 'Shiva'],
    ['P3', '2026-09-25', 400000, 'Bank', 'RTGS ICIC26268K02', 'Admin'],
    ['P1', '2026-09-26', 60000, 'UPI', 'UPI 626912004471', 'Site Engineer'],
    ['P5', '2026-10-01', 200000, 'Bank', 'NEFT HDFC26274402', 'Admin'],
    ['P2', '2026-10-03', 200000, 'Bank', 'NEFT KKBK26276331', 'Admin']
  ].map((r, i) => ({ id: 'R' + (i + 1), no: 'RCT/26-27/' + String(i + 1).padStart(4, '0'), pid: r[0], date: r[1], amt: r[2], mode: r[3], ref: r[4], by: r[5], note: '' }));

  const E = (pid, date, part, cat, amt, by, mode, to, status, sub) => ({ pid, date, part, cat, amt, by, mode, to: to || '', status: status || 'approved', sub: sub || 'Accounts Admin' });
  const ex = [
    // CSD-PRJ-0001 · Hire Nexa (from payment sheet)
    E('P1', '2026-09-12', 'FC – Jones – Gypsum partition work – Advance', 'Subcontract (FC)', 50000, 'Saravanan', 'UPI', 'Jones'),
    E('P1', '2026-09-13', '18mm ply – 1 sheet – Sri Bagavathy Plywood', 'Material', 1984, 'Shiva', 'UPI', 'Sri Bagavathy Ply'),
    E('P1', '2026-09-14', 'Porter', 'Transport', 300, 'Shiva', 'UPI'),
    E('P1', '2026-09-14', 'Porter', 'Transport', 964, 'Shiva', 'UPI'),
    E('P1', '2026-09-15', 'Electrician Anbalagan (Mohan)', 'Labour', 300, 'Shiva', 'UPI', 'Anbalagan'),
    E('P1', '2026-09-16', 'Fuel expenses – site visit – Shiva', 'Fuel', 1000, 'Saravanan', 'UPI'),
    E('P1', '2026-09-19', 'Door frames – Kovur', 'Material', 10000, 'Saravanan', 'UPI', 'Veneers & Ply'),
    E('P1', '2026-09-22', 'Toughened glass – labour charges – Suresh – 1st advance (42,000 − 25,000)', 'Material', 25000, 'Admin', 'Cash', 'Suresh'),
    E('P1', '2026-09-22', 'Veneers & Ply – final amount – door frames', 'Material', 10000, 'Admin', 'UPI', 'Veneers & Ply'),
    E('P1', '2026-09-22', 'Porter – frames Kovur to site', 'Transport', 1120, 'Saravanan', 'UPI'),
    E('P1', '2026-09-22', 'FC – Jones 2nd advance', 'Subcontract (FC)', 20000, 'Saravanan', 'UPI', 'Jones'),
    E('P1', '2026-09-23', 'Teakwood beading & imported – Cochin Timber', 'Material', 7337, 'Admin', 'UPI', 'Cochin Timber'),
    E('P1', '2026-09-23', 'Carpentry hardwares – Deepak Yadav', 'Material', 320, 'Admin', 'UPI', 'Deepak'),
    E('P1', '2026-09-23', 'Water can 4 nos – electricians', 'Miscellaneous', 200, 'Saravanan', 'UPI'),
    E('P1', '2026-09-23', '80316 SU – Century – 2 sheet – Suresh Traders', 'Material', 1980, 'Admin', 'UPI', 'Suresh Traders'),
    E('P1', '2026-09-23', 'Carpentry material and tools (Deepak)', 'Material', 1570, 'Saravanan', 'UPI', 'Deepak'),
    E('P1', '2026-09-23', 'Carpenter Deepak – food and bedsheets', 'Miscellaneous', 600, 'Saravanan', 'UPI', 'Deepak'),
    E('P1', '2026-09-23', 'Porter (Karthik) – laminates – Suresh Traders to Wood Zo', 'Transport', 400, 'Admin', 'UPI', 'Karthik'),
    E('P1', '2026-09-23', '60x32 HMR board – Lune Line Interior', 'Material', 1920, 'Admin', 'UPI', 'Lune Line Interior'),
    E('P1', '2026-09-23', 'Porter (Prakash) – Madhavaram to Cochin Timber to site', 'Transport', 1524, 'Admin', 'UPI', 'Prakash'),
    E('P1', '2026-09-24', 'Paint materials', 'Material', 3300, 'Saravanan', 'UPI'),
    E('P1', '2026-09-24', 'Pratik hardwares (Neogen)', 'Material', 13100, 'Saravanan', 'UPI', 'Neogen'),
    E('P1', '2026-09-24', 'Hettich sliding track – Royal Hardwares', 'Material', 5126, 'Admin', 'UPI', 'Royal Hardwares'),
    E('P1', '2026-09-24', 'Porter (Arokiaraj) – Royal Hardwares to site', 'Transport', 264, 'Admin', 'UPI', 'Arokia Raj'),
    E('P1', '2026-09-24', 'Porter (Subramani) – Arun Hospital to Kovilambakkam', 'Transport', 325, 'Admin', 'UPI', 'Subramani'),
    E('P1', '2026-09-24', 'Porter (Vinod) – beading shop to Medavakkam site', 'Transport', 350, 'Admin', 'UPI', 'Vinod'),
    E('P1', '2026-09-24', 'Cleaner Karthik +1 – 24/09/26', 'Labour', 2400, 'Admin', 'UPI', 'Karthik'),
    E('P1', '2026-09-25', 'Paint materials (Guru)', 'Material', 12720, 'Saravanan', 'UPI', 'Guru'),
    E('P1', '2026-09-25', '18mm com. ply – Amirtham Timber', 'Material', 1800, 'Admin', 'UPI', 'Guru'),
    E('P1', '2026-09-25', 'Porter – plywood – Amirtham Timber to site', 'Transport', 200, 'Admin', 'UPI', 'Guru'),
    E('P1', '2026-09-25', '80316 SU – Century – 2 sheet – Suresh Traders', 'Material', 1980, 'Admin', 'UPI', 'Suresh Traders'),
    E('P1', '2026-09-25', 'Porter (Subramani) – laminates – Suresh Traders to site', 'Transport', 410, 'Admin', 'UPI', 'Subramani'),
    E('P1', '2026-09-25', 'Enamel paint 8559 – Revathi Paints', 'Material', 412, 'Admin', 'UPI', 'Revathi Paints'),
    E('P1', '2026-09-25', 'Enamel paint L136 – Ponram Traders (Guru)', 'Material', 380, 'Admin', 'UPI', 'Ponram Traders'),
    E('P1', '2026-09-26', 'Advance – 8mm plain glass 32 sqft – Krishna Glass', 'Material', 1000, 'Admin', 'UPI', 'Krishna Glass'),
    E('P1', '2026-09-26', 'Paint materials (Guru)', 'Material', 3573, 'Saravanan', 'UPI', 'Guru'),
    E('P1', '2026-09-26', 'Electrician Anbalagan (Mohan)', 'Labour', 500, 'Shiva', 'UPI', 'Anbalagan'),
    E('P1', '2026-09-28', 'Painter (Guru)', 'Labour', 18000, 'Site Engineer', 'Cash', 'Guru'),
    E('P1', '2026-09-28', 'Painter material – inner paint (Guru)', 'Material', 7420, 'Site Engineer', 'Cash', 'Guru'),
    E('P1', '2026-09-28', 'Carpenter Deepak', 'Labour', 12400, 'Site Engineer', 'Cash', 'Deepak Yadav'),
    E('P1', '2026-09-28', 'Balance paid – 8mm plain glass 32 sqft – Krishna Glass', 'Material', 2520, 'Admin', 'UPI', 'Krishna Glass'),
    E('P1', '2026-09-28', 'Transport (Viji) – glass – Krishna Glass to site', 'Transport', 150, 'Admin', 'UPI', 'Viji'),
    E('P1', '2026-09-28', 'Paint materials – Kanchan Electricals (Guru)', 'Material', 3543, 'Admin', 'UPI', 'Kanchan Electrical'),
    E('P1', '2026-09-28', 'Wood Zo (Dhanraj) – job work – bill', 'Material', 1800, 'Admin', 'UPI', 'Wood Zo – Dhanraj'),
    // CSD-PRJ-0002 · Anand Residence
    E('P2', '2026-08-02', 'Greenply BWP 18mm – 40 sheets – advance', 'Material', 120000, 'Admin', 'Bank', 'Greenply Distributors'),
    E('P2', '2026-08-05', 'Modular kitchen hardware – Hafele', 'Material', 86000, 'Admin', 'Bank', 'Hafele India'),
    E('P2', '2026-08-09', 'Carpentry team – Selvam – 1st advance', 'Subcontract (FC)', 80000, 'Shiva', 'Bank', 'Selvam'),
    E('P2', '2026-08-12', 'Porter – plywood to Anna Nagar', 'Transport', 1800, 'Shiva', 'UPI', 'Murugan'),
    E('P2', '2026-08-18', 'Gypsum boards & channels – SR Traders', 'Material', 64000, 'Admin', 'Bank', 'SR Traders'),
    E('P2', '2026-08-25', 'Electrician Anbalagan – wiring', 'Labour', 18000, 'Shiva', 'UPI', 'Anbalagan'),
    E('P2', '2026-09-02', 'Asian Paints Royale – Kanchan Electricals', 'Material', 64000, 'Admin', 'Bank', 'Kanchan Electrical'),
    E('P2', '2026-09-06', 'Painter team – 2 weeks', 'Labour', 42000, 'Shiva', 'Cash', 'Ravi'),
    E('P2', '2026-09-10', 'Fuel – site visits Aug–Sep', 'Fuel', 4200, 'Shiva', 'UPI'),
    E('P2', '2026-09-14', 'Granite countertop – Sri Murugan Granites', 'Material', 96000, 'Admin', 'Bank', 'Sri Murugan Granites'),
    E('P2', '2026-09-20', 'Scaffolding rent – 3 weeks', 'Rent/Equipment', 9000, 'Shiva', 'UPI', 'RK Scaffolding'),
    E('P2', '2026-09-28', 'Site team incentive – kitchen handover', 'Incentives', 10000, 'Saravanan', 'UPI', 'Site team'),
    E('P2', '2026-10-05', 'Greenply – balance payment', 'Material', 66000, 'Admin', 'Bank', 'Greenply Distributors'),
    E('P2', '2026-10-08', 'Cleaning & consumables', 'Miscellaneous', 3500, 'Shiva', 'Cash'),
    // CSD-PRJ-0003 · Vertex Labs
    E('P3', '2026-07-16', 'Team travel – Chennai to Bengaluru', 'Site visit', 14500, 'Shiva', 'Bank'),
    E('P3', '2026-07-20', 'Aluminium partition sections – Jindal', 'Material', 245000, 'Admin', 'Bank', 'Jindal Aluminium'),
    E('P3', '2026-07-28', 'Workstations – 48 seats – Featherlite (job work)', 'Subcontract (FC)', 420000, 'Admin', 'Bank', 'Featherlite Interiors'),
    E('P3', '2026-08-04', 'Toughened glass 12mm – Saint-Gobain', 'Material', 250000, 'Admin', 'Bank', 'Saint-Gobain Glass'),
    E('P3', '2026-08-10', 'Lorry transport – Chennai to Whitefield', 'Transport', 38000, 'Shiva', 'Bank', 'VRL Logistics'),
    E('P3', '2026-08-18', 'Installation team – 15 days', 'Labour', 165000, 'Shiva', 'Bank', 'Selvam'),
    E('P3', '2026-08-26', 'Ceiling grid & lights – Bright Lights Traders', 'Material', 148000, 'Admin', 'Bank', 'Bright Lights Traders'),
    E('P3', '2026-09-03', 'Team stay – service apartment (Aug)', 'Site visit', 36000, 'Shiva', 'Bank', 'Whitefield Stays'),
    E('P3', '2026-09-12', 'Vinyl flooring – supply & lay', 'Subcontract (FC)', 112000, 'Admin', 'Bank', 'FloorCraft'),
    E('P3', '2026-09-19', 'Scissor lift rent', 'Rent/Equipment', 24000, 'Shiva', 'Bank', 'Lift Rentals BLR'),
    E('P3', '2026-09-30', 'Fuel & tolls – September', 'Fuel', 18500, 'Shiva', 'UPI'),
    E('P3', '2026-10-06', 'Handover incentive – install team', 'Incentives', 25000, 'Saravanan', 'Bank', 'Site team'),
    E('P3', '2026-10-09', 'Consumables & housekeeping', 'Miscellaneous', 8200, 'Shiva', 'UPI'),
    // CSD-PRJ-0004 · Meenakshi Clinic
    E('P4', '2026-06-03', 'Vitrified tiles 600x600 – Sri Ganesh Tiles', 'Material', 98000, 'Admin', 'Bank', 'Sri Ganesh Tiles'),
    E('P4', '2026-06-06', 'Mason team – tiling & civil', 'Labour', 86000, 'Shiva', 'Bank', 'Rajesh'),
    E('P4', '2026-06-12', 'Reception counter – Wood Zo (job work)', 'Subcontract (FC)', 112000, 'Admin', 'Bank', 'Wood Zo – Dhanraj'),
    E('P4', '2026-06-18', 'Debris removal & transport', 'Transport', 12500, 'Shiva', 'UPI', 'Kumar Transports'),
    E('P4', '2026-06-24', 'Paint & primer – Revathi Paints', 'Material', 38000, 'Admin', 'UPI', 'Revathi Paints'),
    E('P4', '2026-07-02', 'Painter (Guru)', 'Labour', 46000, 'Shiva', 'Cash', 'Guru'),
    E('P4', '2026-07-08', 'Electrical fittings – Kanchan Electricals', 'Material', 54000, 'Admin', 'Bank', 'Kanchan Electrical'),
    E('P4', '2026-07-15', 'Rework – cabinet shutters (client change)', 'Subcontract (FC)', 18000, 'Shiva', 'UPI', 'Wood Zo – Dhanraj'),
    E('P4', '2026-07-20', 'Site cleaning & handover', 'Miscellaneous', 7500, 'Shiva', 'Cash'),
    // CSD-PRJ-0005 · Sri Balaji Showroom
    E('P5', '2026-10-02', 'ACP sheets – Aludecor – advance', 'Material', 45000, 'Admin', 'Bank', 'Aludecor Dealer'),
    E('P5', '2026-10-04', 'Site measurement & survey – fuel', 'Fuel', 900, 'Site Engineer', 'UPI', '', 'approved', 'Site Engineer'),
    E('P5', '2026-10-07', 'Scaffolding rent – 1 month advance', 'Rent/Equipment', 14000, 'Site Engineer', 'UPI', 'RK Scaffolding', 'approved', 'Site Engineer'),
    // Awaiting owner approval
    E('P1', '2026-10-10', 'Gypsum board – 20 nos – SR Traders', 'Material', 9400, 'Site Engineer', 'UPI', 'SR Traders', 'pending', 'Site Engineer'),
    E('P1', '2026-10-12', 'Porter – boards SR Traders to site', 'Transport', 450, 'Site Engineer', 'UPI', 'Prakash', 'pending', 'Site Engineer'),
    E('P5', '2026-10-13', 'Welder – facade frame (2 days)', 'Labour', 3600, 'Site Engineer', 'Cash', 'Basheer', 'pending', 'Site Engineer'),
    E('P1', '2026-10-13', 'Electrician Anbalagan (Mohan)', 'Labour', 800, 'Site Engineer', 'UPI', 'Anbalagan', 'pending', 'Site Engineer')
  ];
  const expenses = ex.map((e, i) => Object.assign({ id: 'E' + String(i + 1).padStart(4, '0'), bill: 'IMG_' + (2101 + i) + '.jpg', billUrl: '' }, e));

  const B = (no, vendor, gstin, inter, pid, date, due, total, gst, paid, cat) => ({ no, vendor, gstin, inter, pid, date, due, total, gst, taxable: total - gst, paid, cat });
  const bills = [
    B('JGW/112', 'Jones Gypsum Works', '33AFKPJ5521L1Z8', false, 'P1', '2026-09-12', '2026-10-12', 120000, 18305, 70000, 'Subcontract (FC)'),
    B('SGW-26-41', 'Suresh Glass Works', '', false, 'P1', '2026-09-22', '2026-10-06', 42000, 0, 25000, 'Material'),
    B('NG/2290', 'Neogen Hardwares', '33AAQFN8812D1Z3', false, 'P1', '2026-09-24', '2026-10-24', 13100, 1998, 13100, 'Material'),
    B('CT-5531', 'Cochin Timber', '33AACFC3307H1Z1', false, 'P1', '2026-09-23', '2026-10-23', 7337, 1119, 7337, 'Material'),
    B('RH/0874', 'Royal Hardwares', '33AHBPR1190E1Z6', false, 'P1', '2026-09-24', '2026-10-24', 5126, 782, 5126, 'Material'),
    B('GPD/7781', 'Greenply Distributors', '33AABCG4410P1Z2', false, 'P2', '2026-08-02', '2026-09-01', 186000, 28373, 186000, 'Material'),
    B('HIN/26/3302', 'Hafele India', '33AAACH2381J1ZQ', false, 'P2', '2026-08-05', '2026-09-04', 86000, 13119, 86000, 'Material'),
    B('KE/1440', 'Kanchan Electricals', '33ALJPK7710Q1Z5', false, 'P2', '2026-09-02', '2026-10-02', 64000, 9763, 64000, 'Material'),
    B('SMG/1182', 'Sri Murugan Granites', '33BCDPM6643R1Z0', false, 'P2', '2026-09-14', '2026-10-14', 112000, 17085, 96000, 'Material'),
    B('FLI/BLR/219', 'Featherlite Interiors', '29AACCF2210B1Z7', true, 'P3', '2026-07-28', '2026-08-27', 495600, 75600, 420000, 'Subcontract (FC)'),
    B('SGG/KA/5521', 'Saint-Gobain Glass', '29AABCS1429B1ZB', true, 'P3', '2026-08-04', '2026-09-03', 340000, 51864, 250000, 'Material'),
    B('HIN/26/4120', 'Hafele India', '33AAACH2381J1ZQ', false, 'P3', '2026-09-22', '2026-10-22', 122000, 18610, 0, 'Material'),
    B('WZ/26/061', 'Wood Zo – Dhanraj', '33AYFPD4471K1Z9', false, 'P4', '2026-06-12', '2026-07-12', 148000, 22576, 130000, 'Subcontract (FC)')
  ].map((b, i) => Object.assign({ id: 'B' + (i + 1) }, b));

  const staff = [
    ['Saravanan S', 'Managing Partner', 0, 0, 0], // drawings, not salaried
    ['Shiva', 'Project Manager', 48000, 0, 2000],
    ['Accounts Admin', 'Accounts & Purchase', 30000, 0, 0],
    ['Interior Designer', 'Design', 42000, 1800, 0],
    ['Site Engineer', 'Site execution', 32000, 0, 1500],
    ['Office Assistant', 'Office', 18000, 0, 0]
  ].filter(s => s[2] > 0).map(s => ({ name: s[0], role: s[1], gross: s[2], tds: s[3], adv: s[4] }));
  const daily = [
    ['Anbalagan', 'Electrician', 'P1', 900, 18, 12000],
    ['Karthik', 'Cleaner', 'P1', 600, 8, 2400],
    ['Vinod', 'Helper', 'P1', 650, 12, 5000],
    ['Mohan', 'Electrician helper', 'P2', 700, 16, 11200],
    ['Rajesh', 'Mason', 'P5', 1000, 6, 0],
    ['Basheer', 'Welder', 'P5', 1200, 2, 0]
  ].map(d => ({ name: d[0], trade: d[1], pid: d[2], rate: d[3], days: d[4], paid: d[5] }));
  const contractors = [
    ['Jones Gypsum Works', 'Gypsum partitions & ceiling', 'P1', 120000, 70000],
    ['Deepak Yadav', 'Carpentry', 'P1', 85000, 12400],
    ['Guru', 'Painting', 'P1', 60000, 18000],
    ['Suresh', 'Toughened glass – labour', 'P1', 42000, 25000],
    ['Selvam', 'Carpentry & false ceiling', 'P2', 160000, 80000],
    ['Featherlite Interiors', 'Workstations – 48 seats', 'P3', 495600, 420000]
  ].map(c => ({ name: c[0], work: c[1], pid: c[2], value: c[3], paid: c[4] }));

  const items = [
    ['18mm BWP plywood', 'Board', 'Sheet', 1, 1984, 'Sri Bagavathy Ply', 'P1'],
    ['18mm commercial plywood', 'Board', 'Sheet', 1, 1800, 'Amirtham Timber', 'P1'],
    ['Century laminate 80316 SU', 'Laminate', 'Sheet', 4, 3960, 'Suresh Traders', 'P1'],
    ['HMR board 60x32', 'Board', 'Sheet', 1, 1920, 'Lune Line Interior', 'P1'],
    ['Teakwood beading (imported)', 'Wood', 'Rft', 140, 7337, 'Cochin Timber', 'P1'],
    ['Door frames', 'Wood', 'Nos', 6, 20000, 'Veneers & Ply', 'P1'],
    ['Hettich sliding track', 'Hardware', 'Set', 4, 5126, 'Royal Hardwares', 'P1'],
    ['Pratik hardware kit', 'Hardware', 'Lot', 1, 13100, 'Neogen Hardwares', 'P1'],
    ['Interior emulsion & primer', 'Paint', 'Ltr', 96, 27013, 'Guru / Kanchan', 'P1'],
    ['Enamel paint 8559 / L136', 'Paint', 'Ltr', 4, 792, 'Revathi / Ponram', 'P1'],
    ['8mm plain glass', 'Glass', 'Sqft', 32, 3520, 'Krishna Glass', 'P1'],
    ['Greenply BWP 18mm', 'Board', 'Sheet', 40, 186000, 'Greenply Distributors', 'P2'],
    ['Modular kitchen hardware', 'Hardware', 'Lot', 1, 86000, 'Hafele India', 'P2'],
    ['Granite countertop', 'Stone', 'Sqft', 85, 112000, 'Sri Murugan Granites', 'P2'],
    ['Aluminium partition sections', 'Metal', 'Kg', 820, 245000, 'Jindal Aluminium', 'P3'],
    ['Toughened glass 12mm', 'Glass', 'Sqft', 1450, 340000, 'Saint-Gobain Glass', 'P3'],
    ['Vitrified tiles 600x600', 'Tiles', 'Box', 140, 98000, 'Sri Ganesh Tiles', 'P4'],
    ['ACP sheets 4mm', 'Cladding', 'Sheet', 60, 45000, 'Aludecor Dealer', 'P5']
  ].map(r => ({ item: r[0], cat: r[1], unit: r[2], qty: r[3], amt: r[4], vendor: r[5], pid: r[6] }));

  const matrix = [
    ['Dashboard', 'Full', 'Full', 'No profit', 'Own sites'],
    ['Projects & ledger', 'Full', 'Full', 'Full', 'Own sites'],
    ['Project profit & loss', 'Full', '—', '—', '—'],
    ['Invoices & receipts', 'Full', 'Full', 'Full', '—'],
    ['Purchase bills', 'Full', 'Full', 'Full', '—'],
    ['Add expenses', 'Full', 'Full', 'Full', 'Own sites'],
    ['Approve expenses', 'Full', '—', '—', '—'],
    ['Cash, bank & UPI', 'Full', 'Full', '—', '—'],
    ['Outstanding', 'Full', 'Full', 'View', '—'],
    ['GST', 'Full', 'Full', 'View', '—'],
    ['Reports', 'Full', 'Full', 'No profit', '—'],
    ['Payroll', 'Full', 'Full', '—', '—'],
    ['Inventory', 'Full', 'Full', 'Full', 'View'],
    ['Users & security', 'Full', 'Users only', '—', '—']
  ];
  const security = [
    ['Login', 'Work email + password; 5 failed attempts lock the account for 15 minutes', 'On'],
    ['Session timeout', 'Signed out after 30 minutes idle', '30 min'],
    ['Password policy', '12+ characters, changed every 90 days', 'On'],
    ['Period lock', 'Entries on or before this date are read-only', '30 Sep 2026'],
    ['Audit trail', 'Every create, edit and delete is logged', 'Always on'],
    ['Data retention', 'Books kept 8 years (Companies Act, s.128)', '8 years'],
    ['Backups', 'Encrypted daily, 30-day point-in-time restore', 'Daily']
  ];
  const audit = [
    ['2026-10-13 18:42', 'Site Engineer', 'Submitted expense ₹3,600 · CSD-PRJ-0005 (pending approval)'],
    ['2026-10-13 17:10', 'Site Engineer', 'Submitted expense ₹800 · CSD-PRJ-0001 (pending approval)'],
    ['2026-10-13 11:05', 'Accounts Admin', 'Recorded bill SMG/1182 · Sri Murugan Granites'],
    ['2026-10-12 16:20', 'Saravanan S', 'Locked books till 30 Sep 2026'],
    ['2026-10-10 09:12', 'Shiva', 'Edited expense E0044 · amount ₹1,700 → ₹1,800'],
    ['2026-10-03 14:31', 'Accounts Admin', 'Recorded receipt RCT/26-27/0013 · ₹2,00,000']
  ];
  return { company, users, clients, projects, invoices, receipts, expenses, bills, staff, daily, contractors, items, matrix, security, audit };
})();
