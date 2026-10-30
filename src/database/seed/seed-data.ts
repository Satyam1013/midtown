// Seed fixtures. These MUST mirror the front-ends' local state
// (midtown-manager-react / midtown-guest-react) so both apps run unchanged.
//
// ⚠ UNVERIFIED: the front-end source was not available when this was
// written. These values were carried over from an earlier placeholder set
// and have NOT been checked against the React apps. Before go-live, replace
// every value below with the apps' local-state data: tariffs, room→type
// mapping, menu names/prices/veg flags/descriptions, staff, stock.
// Money is written as strings so it never passes through a JS float.

export const roomTypes = [
  {
    name: 'Standard',
    tariff: '1800.00',
    beds: '1 Queen',
    size: '180 sq ft',
    sleeps: 2,
    blurb: 'A comfortable room for a short business or family stay.',
    perks: ['AC', 'Wi-Fi', 'LED TV', 'Hot water'],
    sortOrder: 1,
  },
  {
    name: 'Deluxe',
    tariff: '2500.00',
    beds: '1 King',
    size: '220 sq ft',
    sleeps: 2,
    blurb: 'More space, a king bed and a work desk.',
    perks: ['AC', 'Wi-Fi', 'LED TV', 'Work desk', 'Tea/coffee maker'],
    sortOrder: 2,
  },
  {
    name: 'Executive',
    tariff: '3200.00',
    beds: '1 King',
    size: '260 sq ft',
    sleeps: 3,
    blurb: 'Larger room with a sitting area, ideal for longer stays.',
    perks: ['AC', 'Wi-Fi', 'Smart TV', 'Sitting area', 'Mini fridge', 'Breakfast'],
    sortOrder: 3,
  },
  {
    name: 'Suite',
    tariff: '4500.00',
    beds: '1 King + sofa bed',
    size: '380 sq ft',
    sleeps: 4,
    blurb: 'Separate living room and bedroom — our best.',
    perks: ['AC', 'Wi-Fi', 'Smart TV', 'Living room', 'Mini fridge', 'Breakfast', 'Bathtub'],
    sortOrder: 4,
  },
] as const;

export type RoomTypeName = (typeof roomTypes)[number]['name'];

// 3 floors × 6 rooms. Each room's rate defaults to its type's tariff.
const block = (numbers: number[], floor: number, type: RoomTypeName) =>
  numbers.map((n) => ({ number: String(n), floor, type }));

export const rooms: { number: string; floor: number; type: RoomTypeName }[] = [
  ...block([101, 102, 103, 104], 1, 'Standard'),
  ...block([105, 106], 1, 'Deluxe'),
  ...block([201, 202, 203, 204], 2, 'Deluxe'),
  ...block([205, 206], 2, 'Executive'),
  ...block([301, 302, 303, 304], 3, 'Executive'),
  ...block([305, 306], 3, 'Suite'),
];

export const menuItems = [
  { name: 'Masala Tea', price: '30.00', category: 'Beverages', isVeg: true, description: 'Kadak chai with ginger and cardamom.' },
  { name: 'Filter Coffee', price: '50.00', category: 'Beverages', isVeg: true, description: 'South Indian decoction coffee with milk.' },
  { name: 'Fresh Lime Soda', price: '70.00', category: 'Beverages', isVeg: true, description: 'Sweet, salted or mixed.' },
  { name: 'Aloo Paratha', price: '90.00', category: 'Breakfast', isVeg: true, description: 'Two parathas with curd, pickle and butter.' },
  { name: 'Poha', price: '60.00', category: 'Breakfast', isVeg: true, description: 'Flattened rice with peanuts, sev and lemon.' },
  { name: 'Masala Omelette', price: '80.00', category: 'Breakfast', isVeg: false, description: 'Three-egg omelette with onion, chilli and toast.' },
  { name: 'Veg Pakoda', price: '90.00', category: 'Snacks', isVeg: true, description: 'Mixed vegetable fritters with green chutney.' },
  { name: 'Paneer Tikka', price: '240.00', category: 'Starters', isVeg: true, description: 'Tandoor-grilled cottage cheese, mint chutney.' },
  { name: 'Chicken Tikka', price: '280.00', category: 'Starters', isVeg: false, description: 'Boneless chicken, tandoor-grilled.' },
  { name: 'Dal Tadka', price: '160.00', category: 'Main Course', isVeg: true, description: 'Yellow dal tempered with ghee, cumin and garlic.' },
  { name: 'Paneer Butter Masala', price: '240.00', category: 'Main Course', isVeg: true, description: 'Paneer in a rich tomato-butter gravy.' },
  { name: 'Butter Chicken', price: '300.00', category: 'Main Course', isVeg: false, description: 'Tandoori chicken in a creamy tomato gravy.' },
  { name: 'Veg Thali', price: '220.00', category: 'Thali', isVeg: true, description: 'Dal, two sabzi, rice, roti, salad and sweet.' },
  { name: 'Jeera Rice', price: '120.00', category: 'Rice & Breads', isVeg: true, description: 'Basmati rice tempered with cumin.' },
  { name: 'Butter Roti', price: '25.00', category: 'Rice & Breads', isVeg: true, description: 'Tandoori roti with butter.' },
  { name: 'Gulab Jamun', price: '70.00', category: 'Desserts', isVeg: true, description: 'Two pieces, served warm.' },
];

export const staff = [
  { name: 'Ramesh Sahu', role: 'Manager', shift: 'Day', salary: '25000.00' },
  { name: 'Anil Patel', role: 'Front Desk', shift: 'Day', salary: '15000.00' },
  { name: 'Suresh Yadav', role: 'Front Desk', shift: 'Night', salary: '15000.00' },
  { name: 'Mohan Verma', role: 'Chef', shift: 'Day', salary: '20000.00' },
  { name: 'Raju Nishad', role: 'Waiter', shift: 'Day', salary: '11000.00' },
  { name: 'Geeta Bai', role: 'Housekeeping', shift: 'Day', salary: '10000.00' },
];

export const stockItems = [
  { item: 'Bath Towel', category: 'Linen', unit: 'pcs', qty: '60', minQty: '20', rate: '250.00' },
  { item: 'Bedsheet', category: 'Linen', unit: 'pcs', qty: '50', minQty: '20', rate: '400.00' },
  { item: 'Soap', category: 'Amenities', unit: 'pcs', qty: '200', minQty: '50', rate: '12.00' },
  { item: 'Shampoo Sachet', category: 'Amenities', unit: 'pcs', qty: '300', minQty: '100', rate: '3.00' },
  { item: 'Mineral Water 1L', category: 'Amenities', unit: 'bottle', qty: '120', minQty: '48', rate: '15.00' },
  { item: 'Rice (Basmati)', category: 'Kitchen', unit: 'kg', qty: '40', minQty: '10', rate: '110.00' },
  { item: 'Refined Oil', category: 'Kitchen', unit: 'L', qty: '30', minQty: '10', rate: '140.00' },
  { item: 'Paneer', category: 'Kitchen', unit: 'kg', qty: '5', minQty: '2', rate: '360.00' },
];
