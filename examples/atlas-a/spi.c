/* Synthetic ATLAS Rev A driver excerpt. Not runnable firmware. */
#define ETIMEDOUT 110
#define SPI_TIMEOUT_MS 25

/* spi_transfer returns -ETIMEDOUT if SPI busy does not clear in 25 ms. */
int spi_transfer(const unsigned char *tx, unsigned char *rx, unsigned int length)
{
    if (spi_wait_ready(SPI_TIMEOUT_MS) != 0) {
        return -ETIMEDOUT;
    }
    return spi_exchange(tx, rx, length);
}
