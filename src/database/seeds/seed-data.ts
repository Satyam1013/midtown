// Seed fixtures, matched to the front-end source on 2026-10-31:
// tariffs, room mapping, menu names/prices/categories, staff and stock from
// yashsakhla/midtown-admin src/data/seed.js; room type details from
// yashsakhla/midtown-hotel src/data/seed.js.
//
// ⚠ Menu veg flags are inferred from the names and descriptions are drafts:
// neither repo has them. Confirm both with the hotel before go-live.
// Money is written as strings so it never passes through a JS float.

export const roomTypes = [
  {
    name: 'Standard',
    tariff: '1800.00',
    beds: 'One queen bed',
    size: '180 sq ft',
    sleeps: 2,
    blurb: 'A calm, well-lit room with everything you need for a short stay — hot water around the clock, a work desk and daily housekeeping.',
    perks: ['Air conditioned', 'Free Wi-Fi', 'LED TV', 'Daily housekeeping'],
    sortOrder: 1,
  },
  {
    name: 'Deluxe',
    tariff: '2600.00',
    beds: 'One king bed',
    size: '240 sq ft',
    sleeps: 2,
    blurb: 'More room to spread out, a seating corner by the window and a larger bathroom. Our most booked room.',
    perks: ['Air conditioned', 'Free Wi-Fi', 'LED TV', 'Seating corner', 'Tea & coffee tray'],
    sortOrder: 2,
  },
  {
    name: 'Executive',
    tariff: '3400.00',
    beds: 'One king bed + sofa',
    size: '310 sq ft',
    sleeps: 3,
    blurb: 'Built for a longer stay or a business trip — a proper writing desk, a sofa that sleeps one and complimentary breakfast.',
    perks: ['Air conditioned', 'Free Wi-Fi', 'Work desk', 'Breakfast included', 'Early check-in on request'],
    sortOrder: 3,
  },
  {
    name: 'Suite',
    tariff: '5200.00',
    beds: 'King bed + living room',
    size: '480 sq ft',
    sleeps: 4,
    blurb: 'A separate living room, a dining table for four and the best view in the building. Our family and celebration room.',
    perks: ['Living room', 'Breakfast included', 'Free Wi-Fi', 'Mini fridge', 'Late check-out on request'],
    sortOrder: 4,
  },
] as const;

export type RoomTypeName = (typeof roomTypes)[number]['name'];

// 3 floors × 6 rooms. Each room's rate defaults to its type's tariff.
const floorPlan: [number, [string, RoomTypeName][]][] = [
  [1, [['101', 'Standard'], ['102', 'Standard'], ['103', 'Deluxe'], ['104', 'Deluxe'], ['105', 'Standard'], ['106', 'Executive']]],
  [2, [['201', 'Deluxe'], ['202', 'Deluxe'], ['203', 'Executive'], ['204', 'Executive'], ['205', 'Standard'], ['206', 'Deluxe']]],
  [3, [['301', 'Executive'], ['302', 'Suite'], ['303', 'Suite'], ['304', 'Deluxe'], ['305', 'Executive'], ['306', 'Standard']]],
];

export const rooms = floorPlan.flatMap(([floor, list]) =>
  list.map(([number, type]) => ({ number, floor, type })),
);

export const menuItems = [
  { name: 'Veg Thali', price: '220.00', category: 'Main', isVeg: true, description: 'Dal, two sabzi, rice, roti, salad and sweet.' },
  { name: 'Non-veg Thali', price: '320.00', category: 'Main', isVeg: false, description: 'Chicken curry, dal, rice, roti and salad.' },
  { name: 'Paneer Butter Masala', price: '260.00', category: 'Main', isVeg: true, description: 'Paneer in a rich tomato-butter gravy.' },
  { name: 'Chicken Curry', price: '310.00', category: 'Main', isVeg: false, description: 'Home-style chicken in onion-tomato gravy.' },
  { name: 'Dal Tadka', price: '180.00', category: 'Main', isVeg: true, description: 'Yellow dal tempered with ghee, cumin and garlic.' },
  { name: 'Veg Biryani', price: '240.00', category: 'Main', isVeg: true, description: 'Basmati rice layered with vegetables and spices.' },
  { name: 'Butter Roti', price: '25.00', category: 'Bread', isVeg: true, description: 'Tandoori roti with butter.' },
  { name: 'Tandoori Roti', price: '20.00', category: 'Bread', isVeg: true, description: 'Whole-wheat roti from the tandoor.' },
  { name: 'Jeera Rice', price: '150.00', category: 'Rice', isVeg: true, description: 'Basmati rice tempered with cumin.' },
  { name: 'Masala Dosa', price: '120.00', category: 'Snacks', isVeg: true, description: 'Crisp dosa with potato masala, sambar and chutney.' },
  { name: 'Veg Pakoda', price: '110.00', category: 'Snacks', isVeg: true, description: 'Mixed vegetable fritters with green chutney.' },
  { name: 'Green Salad', price: '90.00', category: 'Snacks', isVeg: true, description: 'Fresh cucumber, tomato, onion and lemon.' },
  { name: 'Masala Chai', price: '20.00', category: 'Beverage', isVeg: true, description: 'Kadak chai with ginger and cardamom.' },
  { name: 'Cold Drink', price: '40.00', category: 'Beverage', isVeg: true, description: 'Chilled soft drink.' },
  { name: 'Fresh Lime Soda', price: '60.00', category: 'Beverage', isVeg: true, description: 'Sweet, salted or mixed.' },
  { name: 'Gulab Jamun', price: '80.00', category: 'Dessert', isVeg: true, description: 'Two pieces, served warm.' },
];

export const staff = [
  { name: 'Suresh Kumar', role: 'Front desk', shift: 'Morning', salary: '18000.00' },
  { name: 'Meena Sahu', role: 'Housekeeping', shift: 'Morning', salary: '12000.00' },
  { name: 'Imran Khan', role: 'Chef', shift: 'General', salary: '26000.00' },
  { name: 'Ravi Nishad', role: 'Waiter', shift: 'Evening', salary: '11000.00' },
  { name: 'Ganesh Rao', role: 'Security', shift: 'Night', salary: '13000.00' },
  { name: 'Pooja Sinha', role: 'Cashier', shift: 'Evening', salary: '16000.00' },
];

export const stockItems = [
  { item: 'Bath towel', category: 'Linen', unit: 'pcs', qty: '48', minQty: '40', rate: '180.00' },
  { item: 'Bed sheet', category: 'Linen', unit: 'pcs', qty: '32', minQty: '40', rate: '420.00' },
  { item: 'Toiletry kit', category: 'Amenities', unit: 'kit', qty: '120', minQty: '60', rate: '35.00' },
  { item: 'Mineral water 1L', category: 'Beverage', unit: 'btl', qty: '24', minQty: '48', rate: '14.00' },
  { item: 'Basmati rice', category: 'Kitchen', unit: 'kg', qty: '55', minQty: '25', rate: '96.00' },
  { item: 'Refined oil', category: 'Kitchen', unit: 'ltr', qty: '18', minQty: '20', rate: '142.00' },
  { item: 'LPG cylinder', category: 'Kitchen', unit: 'cyl', qty: '3', minQty: '2', rate: '1810.00' },
  { item: 'Floor cleaner', category: 'Housekeeping', unit: 'ltr', qty: '12', minQty: '10', rate: '88.00' },
];
