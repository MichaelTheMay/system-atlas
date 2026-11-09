import { getJson } from '@shop/http';

console.log(await getJson('http://localhost:8080/products'));
